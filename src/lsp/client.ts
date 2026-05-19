import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LspClientOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
}

export interface LspLocation {
  uri: string;
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  targetUri?: string;
  targetRange?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class LspStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private stderrChunks: Buffer[] = [];
  private diagnostics = new Map<string, unknown[]>();

  constructor(private readonly options: LspClientOptions) {}

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.readStdout(Buffer.from(chunk)));
    this.child.stderr.on("data", (chunk) => this.appendStderr(Buffer.from(chunk)));
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`language server exited: ${this.stderr()}`));
      }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`language server start timed out after ${this.options.timeoutMs}ms`)), this.options.timeoutMs);
      this.child!.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async initialize(rootUri: string, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          diagnostic: { dynamicRegistration: false },
          hover: { dynamicRegistration: false }
        },
        workspace: {
          workspaceFolders: true,
          configuration: false
        }
      },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }]
    }, timeoutMs);
    this.notify("initialized", {});
    return result;
  }

  didOpen(params: { uri: string; languageId: string; version: number; text: string }): void {
    this.notify("textDocument/didOpen", {
      textDocument: params
    });
  }

  async request(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    await this.start();
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const message = encodeMessage(payload);
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(message);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) {
      throw new Error("language server is not started");
    }
    this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  async settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  publishedDiagnostics(uri: string): unknown[] {
    return this.diagnostics.get(uri) ?? [];
  }

  async shutdown(timeoutMs = 250): Promise<void> {
    if (!this.child) {
      return;
    }
    try {
      await this.request("shutdown", null, timeoutMs);
    } catch {
      // Shutdown is best effort; the caller is already done with the sidecar.
    }
    try {
      this.notify("exit", null);
    } catch {
      // Ignore.
    }
    this.terminateChild("SIGTERM");
    this.child = undefined;
  }

  kill(): void {
    if (!this.child) {
      return;
    }
    this.terminateChild("SIGTERM");
    this.child = undefined;
  }

  stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8").replace(/\s+/gu, " ").trim().slice(0, 600);
  }

  private terminateChild(signal: NodeJS.Signals): void {
    if (!this.child?.pid) {
      return;
    }
    try {
      process.kill(process.platform !== "win32" ? -this.child.pid : this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Best effort only; the LSP sidecar is already being abandoned.
      }
    }
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    let total = this.stderrChunks.reduce((sum, entry) => sum + entry.length, 0);
    while (total > 20_000 && this.stderrChunks.length > 1) {
      const removed = this.stderrChunks.shift();
      total -= removed?.length ?? 0;
    }
  }

  private readStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = /^Content-Length:\s*(\d+)/imu.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(lengthMatch[1]!, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.length < messageEnd) {
        return;
      }
      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: unknown };
        pending.reject(new Error(typeof error.message === "string" ? error.message : "language server request failed"));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && message.params && typeof message.params === "object") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri === "string" && Array.isArray(params.diagnostics)) {
        this.diagnostics.set(params.uri, params.diagnostics);
      }
    }
  }
}

function encodeMessage(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}
