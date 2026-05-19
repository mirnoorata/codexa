import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspStdioClient, type LspLocation } from "./client.js";
import type { CodexaIndex, FileFact, LanguageId, QueryOptions, SymbolFact } from "../types.js";

const DEFAULT_LSP_TIMEOUT_MS = 5000;
const DEFAULT_LSP_MAX_FILES = 3;

export interface LspAssistOptions {
  enabled: boolean;
  timeoutMs: number;
  maxFiles: number;
  servers: Partial<Record<LanguageId, { command: string; args: string[]; cwd?: string }>>;
}

export interface LspLocationSummary {
  uri: string;
  path?: string;
  line?: number;
  character?: number;
}

export interface LspDiagnosticSummary {
  message: string;
  severity?: number;
  line?: number;
  source?: string;
  code?: string;
}

export interface LspAssistResult {
  enabled: boolean;
  status: "disabled" | "ok" | "unavailable";
  language?: LanguageId;
  server?: string;
  file?: string;
  symbol?: string;
  documentSymbols: Array<{ name: string; kind?: number; line?: number }>;
  definitions: LspLocationSummary[];
  references: LspLocationSummary[];
  diagnostics: LspDiagnosticSummary[];
  warnings: string[];
}

export function lspOptionsFromQueryOptions(options: QueryOptions = {}): LspAssistOptions {
  const enabled = options.lsp ?? process.env.CODEXA_LSP === "1";
  const timeoutMs = positiveInt(options.lspTimeoutMs) ?? positiveIntFromEnv("CODEXA_LSP_TIMEOUT_MS") ?? DEFAULT_LSP_TIMEOUT_MS;
  const servers: Partial<Record<LanguageId, { command: string; args: string[]; cwd?: string }>> = {};
  const configured = options.lspServers ?? {};
  for (const [language, config] of Object.entries(configured) as Array<[LanguageId, { command: string; args?: string[]; cwd?: string }]>) {
    servers[language] = { command: config.command, args: config.args ?? [], cwd: config.cwd };
  }
  addEnvironmentServer(servers, "typescript", "CODEXA_LSP_TYPESCRIPT_COMMAND", "CODEXA_LSP_TYPESCRIPT_ARGS_JSON");
  addEnvironmentServer(servers, "javascript", "CODEXA_LSP_JAVASCRIPT_COMMAND", "CODEXA_LSP_JAVASCRIPT_ARGS_JSON");
  addEnvironmentServer(servers, "python", "CODEXA_LSP_PYTHON_COMMAND", "CODEXA_LSP_PYTHON_ARGS_JSON");
  if (!servers.typescript) {
    servers.typescript = discoverServer("typescript-language-server", ["--stdio"]);
  }
  if (!servers.javascript && servers.typescript) {
    servers.javascript = servers.typescript;
  }
  if (!servers.python) {
    servers.python = discoverServer("basedpyright-langserver", ["--stdio"]) ?? discoverServer("pyright-langserver", ["--stdio"]);
  }
  return {
    enabled,
    timeoutMs,
    maxFiles: positiveInt(options.lspMaxFiles) ?? positiveIntFromEnv("CODEXA_LSP_MAX_FILES") ?? DEFAULT_LSP_MAX_FILES,
    servers
  };
}

export async function lspAssistForSymbol(repoRoot: string, index: CodexaIndex, symbol: SymbolFact, options: LspAssistOptions): Promise<LspAssistResult> {
  const file = index.files.find((candidate) => candidate.path === symbol.path);
  if (!file) {
    return disabledOrUnavailable(options, "unavailable", [`symbol file is not indexed: ${symbol.path}`]);
  }
  const position = await positionForSymbol(repoRoot, symbol);
  return await lspAssistForFile(repoRoot, file, options, { symbol, position });
}

export async function lspAssistForFiles(repoRoot: string, files: FileFact[], options: LspAssistOptions): Promise<LspAssistResult[]> {
  if (!options.enabled) {
    return [];
  }
  const selected = files.filter((file) => supportedLanguage(file.language)).slice(0, options.maxFiles);
  const results: LspAssistResult[] = [];
  for (const file of selected) {
    results.push(await lspAssistForFile(repoRoot, file, options));
  }
  return results;
}

async function lspAssistForFile(
  repoRoot: string,
  file: FileFact,
  options: LspAssistOptions,
  target?: { symbol: SymbolFact; position?: { line: number; character: number } }
): Promise<LspAssistResult> {
  if (!options.enabled) {
    return disabledOrUnavailable(options, "disabled", []);
  }
  if (!supportedLanguage(file.language)) {
    return disabledOrUnavailable(options, "unavailable", [`LSP assist does not support ${file.language}`], file);
  }
  const server = options.servers[file.language];
  if (!server) {
    return disabledOrUnavailable(options, "unavailable", [`no LSP server configured or found for ${file.language}`], file);
  }
  const absolutePath = path.join(repoRoot, file.path);
  let text: string;
  try {
    text = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    return disabledOrUnavailable(options, "unavailable", [`could not read ${file.path}: ${errorMessage(error)}`], file);
  }

  const rootUri = pathToFileURL(repoRoot).toString();
  const uri = pathToFileURL(absolutePath).toString();
  const client = new LspStdioClient({
    command: server.command,
    args: server.args,
    cwd: server.cwd ? path.resolve(repoRoot, server.cwd) : repoRoot,
    timeoutMs: options.timeoutMs
  });
  const warnings: string[] = [];
  const deadline = Date.now() + options.timeoutMs;
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`LSP assist timed out after ${options.timeoutMs}ms`);
    }
    return remaining;
  };
  try {
    await client.start();
    await client.initialize(rootUri, remainingMs());
    client.didOpen({ uri, languageId: lspLanguageId(file.language), version: 1, text });
    await client.settle(Math.min(250, remainingMs()));
    const documentSymbols = summarizeDocumentSymbols(await requestOptional(client, "textDocument/documentSymbol", { textDocument: { uri } }, warnings, remainingMs()));
    const definitions = target?.position
      ? summarizeLocations(
          await requestOptional(
            client,
            "textDocument/definition",
            { textDocument: { uri }, position: target.position },
            warnings,
            remainingMs()
          ),
          repoRoot
        )
      : [];
    const references = target?.position
      ? summarizeLocations(
          await requestOptional(
            client,
            "textDocument/references",
            { textDocument: { uri }, position: target.position, context: { includeDeclaration: true } },
            warnings,
            remainingMs()
          ),
          repoRoot
        )
      : [];
    const pullDiagnostics = summarizeDiagnostics(await requestOptional(client, "textDocument/diagnostic", { textDocument: { uri } }, warnings, remainingMs()));
    await client.settle(Math.min(250, remainingMs()));
    const pushDiagnostics = summarizeDiagnostics(client.publishedDiagnostics(uri));
    return {
      enabled: true,
      status: "ok",
      language: file.language,
      server: server.command,
      file: file.path,
      symbol: target?.symbol.qualifiedName,
      documentSymbols,
      definitions,
      references,
      diagnostics: [...pullDiagnostics, ...pushDiagnostics].slice(0, 40),
      warnings
    };
  } catch (error) {
    client.kill();
    return {
      enabled: true,
      status: "unavailable",
      language: file.language,
      server: server.command,
      file: file.path,
      symbol: target?.symbol.qualifiedName,
      documentSymbols: [],
      definitions: [],
      references: [],
      diagnostics: [],
      warnings: [`LSP assist failed: ${errorMessage(error)}${client.stderr() ? `; stderr: ${client.stderr()}` : ""}`]
    };
  } finally {
    await client.shutdown(250);
  }
}

async function requestOptional(client: LspStdioClient, method: string, params: unknown, warnings: string[], timeoutMs: number): Promise<unknown> {
  try {
    return await client.request(method, params, timeoutMs);
  } catch (error) {
    if (errorMessage(error).includes("timed out")) {
      throw error;
    }
    warnings.push(`${method} unavailable: ${errorMessage(error)}`);
    return null;
  }
}

async function positionForSymbol(repoRoot: string, symbol: SymbolFact): Promise<{ line: number; character: number } | undefined> {
  if (!symbol.range) {
    return undefined;
  }
  const text = await fs.readFile(path.join(repoRoot, symbol.path), "utf8").catch(() => "");
  const lineIndex = Math.max(0, symbol.range.startLine - 1);
  const lines = text.split(/\r?\n/u);
  const line = lines[lineIndex] ?? "";
  const lineStartByte = Buffer.byteLength(lines.slice(0, lineIndex).join("\n"), "utf8") + (lineIndex > 0 ? 1 : 0);
  const byteOffsetInLine = Math.max(0, symbol.range.startByte - lineStartByte);
  const character = Buffer.from(line, "utf8").slice(0, byteOffsetInLine).toString("utf8").length;
  return { line: lineIndex, character };
}

function summarizeDocumentSymbols(value: unknown): Array<{ name: string; kind?: number; line?: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<{ name: string; kind?: number; line?: number }> = [];
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as { name?: unknown; kind?: unknown; range?: { start?: { line?: number } }; location?: { range?: { start?: { line?: number } } }; children?: unknown[] };
    if (typeof record.name === "string") {
      out.push({
        name: record.name,
        kind: typeof record.kind === "number" ? record.kind : undefined,
        line: (record.range?.start?.line ?? record.location?.range?.start?.line) !== undefined ? (record.range?.start?.line ?? record.location?.range?.start?.line)! + 1 : undefined
      });
    }
    for (const child of record.children ?? []) {
      visit(child);
    }
  };
  for (const entry of value) {
    visit(entry);
  }
  return out.slice(0, 60);
}

function summarizeLocations(value: unknown, repoRoot: string): LspLocationSummary[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .map((entry): LspLocationSummary | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const loc = entry as LspLocation;
      const uri = loc.uri ?? loc.targetUri;
      if (!uri) {
        return null;
      }
      const relativePath = fileUriToRelativePath(uri, repoRoot);
      if (!relativePath) {
        return null;
      }
      const start = loc.range?.start ?? loc.targetRange?.start;
      return {
        uri,
        path: relativePath,
        line: typeof start?.line === "number" ? start.line + 1 : undefined,
        character: typeof start?.character === "number" ? start.character : undefined
      };
    })
    .filter((entry): entry is LspLocationSummary => Boolean(entry))
    .slice(0, 40);
}

function summarizeDiagnostics(value: unknown): LspDiagnosticSummary[] {
  const diagnostics = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)
      ? (value as { items: unknown[] }).items
      : [];
  return diagnostics
    .map((entry): LspDiagnosticSummary | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as {
        message?: unknown;
        severity?: unknown;
        source?: unknown;
        code?: unknown;
        range?: { start?: { line?: number } };
      };
      if (typeof record.message !== "string") {
        return null;
      }
      return {
        message: record.message,
        severity: typeof record.severity === "number" ? record.severity : undefined,
        line: typeof record.range?.start?.line === "number" ? record.range.start.line + 1 : undefined,
        source: typeof record.source === "string" ? record.source : undefined,
        code: typeof record.code === "string" || typeof record.code === "number" ? String(record.code) : undefined
      };
    })
    .filter((entry): entry is LspDiagnosticSummary => Boolean(entry))
    .slice(0, 40);
}

function disabledOrUnavailable(options: LspAssistOptions, status: "disabled" | "unavailable", warnings: string[], file?: FileFact): LspAssistResult {
  return {
    enabled: options.enabled,
    status,
    language: file?.language,
    file: file?.path,
    documentSymbols: [],
    definitions: [],
    references: [],
    diagnostics: [],
    warnings
  };
}

function supportedLanguage(language: LanguageId): boolean {
  return language === "typescript" || language === "javascript" || language === "python";
}

function lspLanguageId(language: LanguageId): string {
  if (language === "typescript") return "typescript";
  if (language === "javascript") return "javascript";
  if (language === "python") return "python";
  return "plaintext";
}

function addEnvironmentServer(
  servers: Partial<Record<LanguageId, { command: string; args: string[]; cwd?: string }>>,
  language: LanguageId,
  commandEnv: string,
  argsEnv: string
): void {
  const command = process.env[commandEnv];
  if (!command) {
    return;
  }
  servers[language] = {
    command,
    args: jsonStringArray(process.env[argsEnv]) ?? ["--stdio"]
  };
}

function discoverServer(command: string, args: string[]): { command: string; args: string[] } | undefined {
  try {
    execFileSync("sh", ["-c", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return { command, args };
  } catch {
    return undefined;
  }
}

function jsonStringArray(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fileUriToRelativePath(uri: string, repoRoot: string): string | undefined {
  if (!uri.startsWith("file://")) {
    return undefined;
  }
  try {
    const decoded = path.resolve(decodeURIComponent(new URL(uri).pathname));
    const relative = path.relative(path.resolve(repoRoot), decoded);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return relative.split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

function positiveInt(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}

function positiveIntFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  return positiveInt(Number.parseInt(value, 10));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
