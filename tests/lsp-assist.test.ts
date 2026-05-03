import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
import { symbolContextQuery } from "../src/query/inspection.js";

describe("LSP assist", () => {
  it("queries a read-only stdio language server sidecar for symbol context", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-lsp-assist-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "index.ts"), "export function main() { return 1 }\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });

      const server = path.join(repo, "language-server.mjs");
      await writeFile(server, languageServerSource(), "utf8");
      const result = await symbolContextQuery(repo, "main", {
        autoRefresh: false,
        lsp: true,
        lspTimeoutMs: 5000,
        lspServers: {
          typescript: { command: process.execPath, args: [server] }
        }
      });
      const data = result.data as {
        lspAssist?: {
          status: string;
          documentSymbols: Array<{ name: string }>;
          definitions: Array<{ path?: string }>;
          references: Array<{ path?: string }>;
          diagnostics: Array<{ message: string }>;
        };
      };

      expect(data.lspAssist?.status).toBe("ok");
      expect(data.lspAssist?.documentSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "main" })]));
      expect(data.lspAssist?.definitions[0]?.path).toBe("src/index.ts");
      expect(data.lspAssist?.references[0]?.path).toBe("src/index.ts");
      expect(data.lspAssist?.diagnostics[0]?.message).toContain("fixture diagnostic");
      expect(result.text).toContain("LSP assist: ok");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

function languageServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
let openedUri = "";
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  drain();
});

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /^Content-Length:\\s*(\\d+)/imu.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.slice(start, end).toString("utf8"));
    buffer = buffer.slice(end);
    handle(message);
  }
}

function handle(message) {
  if (message.method === "textDocument/didOpen") {
    openedUri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: openedUri,
        diagnostics: [
          {
            message: "fixture diagnostic from language server",
            severity: 2,
            source: "codexa-fixture",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
          }
        ]
      }
    });
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    reply(message.id, {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }
      }
    });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    reply(message.id, [
      {
        name: "main",
        kind: 12,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } }
      }
    ]);
    return;
  }
  if (message.method === "textDocument/definition" || message.method === "textDocument/references") {
    reply(message.id, [
      {
        uri: message.params.textDocument.uri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } }
      }
    ]);
    return;
  }
  if (message.method === "textDocument/diagnostic") {
    reply(message.id, {
      kind: "full",
      items: [
        {
          message: "fixture diagnostic from pull diagnostics",
          severity: 3,
          source: "codexa-fixture",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
        }
      ]
    });
    return;
  }
  if (message.method === "shutdown") {
    reply(message.id, null);
    return;
  }
  reply(message.id, null);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function send(payload) {
  const body = JSON.stringify(payload);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
`.trimStart();
}
