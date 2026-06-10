import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { runCommand } from "./command.js";
import type { CodexaIndex, FileFact, QueryOptions } from "./types.js";
import { stableId, uniqueSorted } from "./util.js";

const SEMANTIC_CACHE_VERSION = 1 as const;
const SEMANTIC_CACHE_DIR = ".codex/cache/codexa-semantic-v1";
const MANIFEST_FILE = "manifest.json";
const VECTORS_FILE = "vectors.jsonl";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_OPENAI_BATCH_CHAR_BUDGET = 120_000;
const DEFAULT_MAX_FILES = 750;
const MAX_SOURCE_CHARS_PER_FILE = 16_000;
const MAX_PREVIEW_CHARS = 280;
const MAX_SEMANTIC_MANIFEST_BYTES = 128 * 1024;
const MAX_SEMANTIC_VECTOR_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_VECTOR_RECORDS = 100_000;
const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export type SemanticProviderKind = "openai" | "local-command";

export interface SemanticProviderOptions {
  provider?: SemanticProviderKind;
  model?: string;
  dimensions?: number;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  batchSize?: number;
}

export interface SemanticQueryOptions extends SemanticProviderOptions {
  enabled: boolean;
  repoRoot: string;
  forced?: boolean;
}

export interface SemanticBuildOptions extends SemanticProviderOptions {
  maxFiles?: number;
}

interface SemanticChunk {
  id: string;
  path: string;
  title: string;
  text: string;
  preview: string;
}

interface SemanticVectorRecord {
  id: string;
  path: string;
  title: string;
  preview: string;
  embedding: number[];
}

interface SemanticManifest {
  schemaVersion: typeof SEMANTIC_CACHE_VERSION;
  snapshotId: string;
  indexedAt: string;
  provider: SemanticProviderKind;
  model: string;
  dimensions: number;
  chunkCount: number;
  builtAt: string;
  vectorsFile: string;
  sourceFingerprint: string;
}

export interface SemanticBuildSummary {
  repoRoot: string;
  cacheDir: string;
  manifestPath: string;
  vectorPath: string;
  provider: SemanticProviderKind;
  model: string;
  dimensions: number;
  chunkCount: number;
  sourceFingerprint: string;
}

export interface SemanticLaneEntry {
  file: FileFact;
  score: number;
  reasons: string[];
  matchedTerms: string[];
}

export interface SemanticRetrievalSummary {
  enabled: boolean;
  status: "disabled" | "ok" | "unavailable";
  provider?: SemanticProviderKind;
  model?: string;
  chunkCount?: number;
  diagnostics: string[];
}

export interface SemanticLaneResult {
  entries: SemanticLaneEntry[];
  summary: SemanticRetrievalSummary;
}

export function semanticOptionsFromQueryOptions(repoRoot: string, options: QueryOptions = {}): SemanticQueryOptions {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const semanticOverride = semanticEnabledOverride(options.semantic);
  const manifest = semanticOverride === false ? undefined : readSemanticManifest(resolvedRepoRoot);
  const provider = semanticProviderFromValue(options.semanticProvider ?? process.env.CODEXA_SEMANTIC_PROVIDER) ?? manifest?.provider ?? inferProviderFromEnvironment(semanticOverride === true);
  const command = options.semanticCommand ?? process.env.CODEXA_SEMANTIC_COMMAND;
  const queryOptions = {
    provider,
    model: options.semanticModel ?? process.env.CODEXA_SEMANTIC_MODEL ?? manifest?.model,
    dimensions: positiveInt(options.semanticDimensions) ?? positiveIntFromEnv("CODEXA_SEMANTIC_DIMENSIONS") ?? manifest?.dimensions,
    command,
    args: options.semanticArgs ?? semanticArgsFromEnv(),
    timeoutMs: positiveInt(options.semanticTimeoutMs) ?? positiveIntFromEnv("CODEXA_SEMANTIC_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
    batchSize: positiveInt(options.semanticBatchSize) ?? positiveIntFromEnv("CODEXA_SEMANTIC_BATCH_SIZE") ?? DEFAULT_BATCH_SIZE
  };
  const enabled = semanticOverride ?? Boolean(manifest && provider && semanticProviderRunnable(provider, queryOptions));
  return {
    enabled,
    repoRoot: resolvedRepoRoot,
    forced: semanticOverride === true,
    ...queryOptions
  };
}

export async function buildSemanticIndex(repoRootInput: string, index: CodexaIndex, options: SemanticBuildOptions): Promise<SemanticBuildSummary> {
  const repoRoot = path.resolve(repoRootInput);
  const providerOptions = semanticProviderOptionsWithEnvironment(options);
  const provider = requiredProvider(providerOptions);
  const model = providerModel(provider, providerOptions.model);
  const chunks = await semanticChunksForIndex(repoRoot, index, options.maxFiles ?? DEFAULT_MAX_FILES);
  if (chunks.length === 0) {
    throw new Error("semantic index has no eligible chunks to embed");
  }
  const embeddings = await embedTexts(
    chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
    { ...providerOptions, provider, model }
  );
  const vectorRecords = chunks.map((chunk) => {
    const embedding = embeddings.get(chunk.id);
    if (!embedding) {
      throw new Error(`semantic provider did not return an embedding for ${chunk.id}`);
    }
    return { id: chunk.id, path: chunk.path, title: chunk.title, preview: chunk.preview, embedding };
  });
  const dimensions = vectorRecords[0]?.embedding.length ?? 0;
  if (dimensions <= 0 || vectorRecords.some((record) => record.embedding.length !== dimensions)) {
    throw new Error("semantic provider returned inconsistent embedding dimensions");
  }

  const cacheDir = path.join(repoRoot, SEMANTIC_CACHE_DIR);
  const builtAt = new Date().toISOString();
  const sourceFingerprint = semanticSourceFingerprint(index, chunks);
  const manifest: SemanticManifest = {
    schemaVersion: SEMANTIC_CACHE_VERSION,
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.freshness.indexedAt,
    provider,
    model,
    dimensions,
    chunkCount: vectorRecords.length,
    builtAt,
    vectorsFile: semanticVectorFileName({ sourceFingerprint, provider, model, dimensions }),
    sourceFingerprint
  };
  await writeSemanticCache(cacheDir, manifest, vectorRecords);
  return {
    repoRoot,
    cacheDir,
    manifestPath: path.join(cacheDir, MANIFEST_FILE),
    vectorPath: path.join(cacheDir, manifest.vectorsFile),
    provider,
    model,
    dimensions,
    chunkCount: vectorRecords.length,
    sourceFingerprint: manifest.sourceFingerprint
  };
}

export function semanticMayUseOpenWorldProvider(repoRoot: string, options: QueryOptions = {}): boolean {
  const semanticOverride = semanticEnabledOverride(options.semantic);
  if (semanticOverride === false) {
    return false;
  }
  const manifest = readSemanticManifest(path.resolve(repoRoot));
  const provider = semanticProviderFromValue(options.semanticProvider ?? process.env.CODEXA_SEMANTIC_PROVIDER) ?? manifest?.provider;
  if (provider === "openai") {
    return semanticOverride === true || Boolean(process.env.OPENAI_API_KEY && manifest);
  }
  return Boolean(semanticOverride === true && process.env.OPENAI_API_KEY && !provider);
}

export async function semanticLaneEntriesForQuery(index: CodexaIndex, query: string, fileByPath: Map<string, FileFact>, options: SemanticQueryOptions): Promise<SemanticLaneResult> {
  if (!options.enabled) {
    return {
      entries: [],
      summary: { enabled: false, status: "disabled", diagnostics: [] }
    };
  }

  const loaded = loadSemanticCache(options.repoRoot);
  if (!loaded.ok) {
    return unavailable(options, [loaded.reason]);
  }
  const { manifest, vectors } = loaded;
  const diagnostics: string[] = [];
  if (manifest.snapshotId !== index.snapshot.snapshotId) {
    diagnostics.push("semantic cache is stale for the current Codexa snapshot; run `codexa semantic-index <repo>`");
  }
  if (manifest.dimensions <= 0 || vectors.length === 0) {
    diagnostics.push("semantic cache contains no vectors");
  }
  const provider = options.provider;
  if (!provider) {
    diagnostics.push("semantic query provider is not configured; set CODEXA_SEMANTIC_PROVIDER or pass query options");
  } else if (provider !== manifest.provider) {
    diagnostics.push(`semantic query provider ${provider} does not match cached provider ${manifest.provider}`);
  }
  const model = provider ? providerModel(provider, options.model) : undefined;
  if (provider && model !== manifest.model) {
    diagnostics.push(`semantic query model ${model} does not match cached model ${manifest.model}`);
  }
  if (options.dimensions && options.dimensions !== manifest.dimensions) {
    diagnostics.push(`semantic query dimensions ${options.dimensions} do not match cached dimensions ${manifest.dimensions}`);
  }
  if (diagnostics.length > 0) {
    if (!options.forced) {
      return {
        entries: [],
        summary: { enabled: false, status: "disabled", diagnostics: [] }
      };
    }
    return {
      entries: [],
      summary: {
        enabled: true,
        status: "unavailable",
        provider: manifest.provider,
        model: manifest.model,
        chunkCount: vectors.length,
        diagnostics
      }
    };
  }

  let queryEmbedding: number[];
  try {
    const embeddings = await embedTexts([{ id: "query", text: query }], { ...options, provider: manifest.provider, model: manifest.model, dimensions: manifest.dimensions });
    queryEmbedding = embeddings.get("query") ?? [];
  } catch (error) {
    return unavailable(options, [`semantic query embedding failed: ${errorMessage(error)}`], manifest);
  }
  if (queryEmbedding.length !== manifest.dimensions) {
    return unavailable(options, [`semantic query embedding dimension ${queryEmbedding.length} does not match cache dimension ${manifest.dimensions}`], manifest);
  }

  const queryVector = normalizeVector(queryEmbedding);
  const byPath = new Map<string, SemanticLaneEntry>();
  for (const record of vectors) {
    const file = fileByPath.get(record.path);
    if (!file || record.embedding.length !== manifest.dimensions) {
      continue;
    }
    const similarity = dot(queryVector, normalizeVector(record.embedding));
    if (!Number.isFinite(similarity) || similarity <= 0.12) {
      continue;
    }
    const existing = byPath.get(file.path) ?? { file, score: 0, reasons: [], matchedTerms: [] };
    existing.score = Math.max(existing.score, similarity * 24);
    existing.reasons.push(`semantic ${record.title} similarity ${similarity.toFixed(3)}: ${record.preview}`);
    byPath.set(file.path, existing);
  }

  return {
    entries: [...byPath.values()]
      .map((entry) => ({ ...entry, reasons: uniqueSorted(entry.reasons).slice(0, 6) }))
      .sort((a, b) => b.score - a.score || b.file.rank - a.file.rank || a.file.path.localeCompare(b.file.path))
      .slice(0, 80),
    summary: {
      enabled: true,
      status: "ok",
      provider: manifest.provider,
      model: manifest.model,
      chunkCount: vectors.length,
      diagnostics: manifest.snapshotId === index.snapshot.snapshotId ? [] : ["semantic cache snapshot differs from current index"]
    }
  };
}

async function semanticChunksForIndex(repoRoot: string, index: CodexaIndex, maxFiles: number): Promise<SemanticChunk[]> {
  const symbolsByPath = groupByPath(index.symbols);
  const usagesByPath = groupByPath(index.usageSites);
  const importsByPath = groupByPath(index.imports);
  const risksByPath = groupByPath(index.risks);
  const workflowsByPath = new Map<string, string[]>();
  for (const workflow of index.workflows) {
    for (const filePath of workflow.relatedFiles) {
      const existing = workflowsByPath.get(filePath) ?? [];
      existing.push(`${workflow.workflowKind} ${workflow.title}: ${workflow.summary}`);
      workflowsByPath.set(filePath, existing);
    }
  }

  const files = index.files
    .filter((file) => !file.generated && !file.path.startsWith(".codex/") && file.sizeBytes <= 512 * 1024)
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, maxFiles));
  const chunks: SemanticChunk[] = [];
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file.path);
    let source = "";
    try {
      source = await fs.readFile(absolutePath, "utf8");
    } catch {
      source = "";
    }
    const symbolText = (symbolsByPath.get(file.path) ?? [])
      .slice(0, 80)
      .map((symbol) => `${symbol.kind} ${symbol.qualifiedName} exported=${symbol.exported}`)
      .join("\n");
    const usageText = (usagesByPath.get(file.path) ?? [])
      .slice(0, 80)
      .map((usage) => `${usage.kind} ${usage.name} ${usage.text}`)
      .join("\n");
    const importText = (importsByPath.get(file.path) ?? [])
      .slice(0, 60)
      .map((imp) => `import ${imp.importedName ?? "*"} from ${imp.specifier} ${imp.resolvedPath ?? ""}`)
      .join("\n");
    const riskText = (risksByPath.get(file.path) ?? [])
      .slice(0, 30)
      .map((risk) => `${risk.signal}: ${risk.reason}`)
      .join("\n");
    const workflowText = (workflowsByPath.get(file.path) ?? []).slice(0, 20).join("\n");
    const text = [
      `file: ${file.path}`,
      `language: ${file.language}`,
      `module: ${moduleNameForPath(file.path)}`,
      symbolText ? `symbols:\n${symbolText}` : "",
      importText ? `imports:\n${importText}` : "",
      usageText ? `usages:\n${usageText}` : "",
      workflowText ? `workflows:\n${workflowText}` : "",
      riskText ? `risks:\n${riskText}` : "",
      source ? `source:\n${source.slice(0, MAX_SOURCE_CHARS_PER_FILE)}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
    chunks.push({
      id: stableId("semantic-chunk", index.snapshot.snapshotId, file.path),
      path: file.path,
      title: file.path,
      text,
      preview: compactPreview(text)
    });
  }
  return chunks;
}

async function embedTexts(items: Array<{ id: string; text: string }>, options: SemanticProviderOptions & { provider: SemanticProviderKind; model: string }): Promise<Map<string, number[]>> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const result = new Map<string, number[]>();
  for (const batch of embeddingBatches(items, batchSize, options.provider === "openai" ? DEFAULT_OPENAI_BATCH_CHAR_BUDGET : Number.POSITIVE_INFINITY)) {
    const embeddings =
      options.provider === "openai"
        ? await embedWithOpenAi(batch, { ...options, provider: "openai" })
        : await embedWithLocalCommand(batch, { ...options, provider: "local-command" });
    for (const [id, embedding] of embeddings) {
      result.set(id, embedding);
    }
  }
  return result;
}

function embeddingBatches(items: Array<{ id: string; text: string }>, maxItems: number, maxChars: number): Array<Array<{ id: string; text: string }>> {
  const batches: Array<Array<{ id: string; text: string }>> = [];
  let current: Array<{ id: string; text: string }> = [];
  let currentChars = 0;
  for (const item of items) {
    const itemChars = item.text.length;
    if (current.length > 0 && (current.length >= maxItems || currentChars + itemChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

async function embedWithOpenAi(items: Array<{ id: string; text: string }>, options: SemanticProviderOptions & { provider: "openai"; model: string }): Promise<Map<string, number[]>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI semantic embeddings");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: options.model,
      input: items.map((item) => item.text),
      encoding_format: "float"
    };
    if (options.dimensions) {
      body.dimensions = options.dimensions;
    }
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI embeddings HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
    const output = new Map<string, number[]>();
    for (const entry of parsed.data ?? []) {
      const item = typeof entry.index === "number" ? items[entry.index] : undefined;
      const embedding = numberArray(entry.embedding);
      if (item && embedding) {
        output.set(item.id, embedding);
      }
    }
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedWithLocalCommand(items: Array<{ id: string; text: string }>, options: SemanticProviderOptions & { provider: "local-command"; model: string }): Promise<Map<string, number[]>> {
  if (!options.command) {
    throw new Error("semantic local-command provider requires a command");
  }
  const input = items.map((item) => `${JSON.stringify({ id: item.id, text: item.text, model: options.model, dimensions: options.dimensions })}\n`).join("");
  const stdout = await runLocalEmbeddingCommand(options.command, options.args ?? [], input, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return parseLocalEmbeddingOutput(stdout);
}

async function runLocalEmbeddingCommand(command: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  const result = await runCommand(command, args, {
    env: localEmbeddingCommandEnv(),
    input,
    killProcessGroup: true,
    maxBufferBytes: MAX_LOCAL_COMMAND_OUTPUT_BYTES,
    timeoutMs
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new Error(`semantic local-command timed out after ${timeoutMs}ms`);
    }
    if (result.truncated) {
      throw new Error(`semantic local-command exceeded Codexa's ${MAX_LOCAL_COMMAND_OUTPUT_BYTES} byte output cap`);
    }
    const status = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.exitCode}`;
    throw new Error(`semantic local-command failed with ${status}: ${result.stderr.slice(0, 600)}`);
  }
  return result.stdout;
}

function localEmbeddingCommandEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function parseLocalEmbeddingOutput(output: string): Map<string, number[]> {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("semantic local-command produced no output");
  }
  let records: unknown[];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      records = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { embeddings?: unknown[] }).embeddings)) {
      records = (parsed as { embeddings: unknown[] }).embeddings;
    } else {
      records = [parsed];
    }
  } catch {
    records = trimmed.split(/\r?\n/u).map((line) => JSON.parse(line) as unknown);
  }
  const embeddings = new Map<string, number[]>();
  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const id = (record as { id?: unknown }).id;
    const embedding = numberArray((record as { embedding?: unknown }).embedding);
    if (typeof id === "string" && embedding) {
      embeddings.set(id, embedding);
    }
  }
  if (embeddings.size === 0) {
    throw new Error("semantic local-command output did not contain {id, embedding} records");
  }
  return embeddings;
}

function loadSemanticCache(repoRoot: string): { ok: true; manifest: SemanticManifest; vectors: SemanticVectorRecord[] } | { ok: false; reason: string } {
  const cacheDir = path.join(repoRoot, SEMANTIC_CACHE_DIR);
  const manifestPath = path.join(cacheDir, MANIFEST_FILE);
  try {
    const manifest = JSON.parse(readSizedTextSync(manifestPath, MAX_SEMANTIC_MANIFEST_BYTES)) as SemanticManifest;
    if (!isManifest(manifest)) {
      return { ok: false, reason: "semantic cache manifest is invalid" };
    }
    const vectorPath = path.join(cacheDir, manifest.vectorsFile);
    const vectorLines = readSizedTextSync(vectorPath, MAX_SEMANTIC_VECTOR_BYTES)
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    if (vectorLines.length > MAX_SEMANTIC_VECTOR_RECORDS) {
      return { ok: false, reason: `semantic cache vector file has too many records: ${vectorLines.length}` };
    }
    const vectors = vectorLines.map((line) => JSON.parse(line) as SemanticVectorRecord).filter((record) => isVectorRecordForManifest(record, manifest));
    if (vectors.length !== manifest.chunkCount) {
      return { ok: false, reason: `semantic cache vector count mismatch: manifest ${manifest.chunkCount}, vectors ${vectors.length}` };
    }
    return { ok: true, manifest, vectors };
  } catch (error) {
    return { ok: false, reason: `semantic cache unavailable: ${errorMessage(error)}` };
  }
}

function readSemanticManifest(repoRoot: string): SemanticManifest | undefined {
  try {
    const manifest = JSON.parse(readSizedTextSync(path.join(repoRoot, SEMANTIC_CACHE_DIR, MANIFEST_FILE), MAX_SEMANTIC_MANIFEST_BYTES)) as SemanticManifest;
    return isManifest(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function readSizedTextSync(filePath: string, maxBytes: number): string {
  const stat = fsSync.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`${path.basename(filePath)} exceeds ${maxBytes} bytes`);
  }
  return fsSync.readFileSync(filePath, "utf8");
}

function isVectorRecordForManifest(record: unknown, manifest: SemanticManifest): record is SemanticVectorRecord {
  return isVectorRecord(record) && record.embedding.length === manifest.dimensions;
}

async function writeSemanticCache(cacheDir: string, manifest: SemanticManifest, vectors: SemanticVectorRecord[]): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const tempSuffix = `.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const manifestTemp = path.join(cacheDir, `${MANIFEST_FILE}${tempSuffix}`);
  const vectorsTemp = path.join(cacheDir, `${manifest.vectorsFile}${tempSuffix}`);
  await fs.writeFile(vectorsTemp, vectors.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await fs.writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(vectorsTemp, path.join(cacheDir, manifest.vectorsFile));
  await fs.rename(manifestTemp, path.join(cacheDir, MANIFEST_FILE));
}

function unavailable(options: SemanticQueryOptions, diagnostics: string[], manifest?: SemanticManifest): SemanticLaneResult {
  return {
    entries: [],
    summary: {
      enabled: true,
      status: "unavailable",
      provider: manifest?.provider ?? options.provider,
      model: manifest?.model ?? options.model,
      chunkCount: manifest?.chunkCount,
      diagnostics
    }
  };
}

function requiredProvider(options: SemanticProviderOptions): SemanticProviderKind {
  const provider = semanticProviderFromValue(options.provider ?? process.env.CODEXA_SEMANTIC_PROVIDER) ?? inferProviderFromEnvironment(true);
  if (!provider) {
    throw new Error("semantic provider is required; use --provider openai or --provider local-command");
  }
  if (provider === "local-command" && !options.command && !process.env.CODEXA_SEMANTIC_COMMAND) {
    throw new Error("local-command semantic provider requires --command or CODEXA_SEMANTIC_COMMAND");
  }
  return provider;
}

function semanticProviderOptionsWithEnvironment(options: SemanticProviderOptions): SemanticProviderOptions {
  return {
    provider: semanticProviderFromValue(options.provider ?? process.env.CODEXA_SEMANTIC_PROVIDER),
    model: options.model ?? process.env.CODEXA_SEMANTIC_MODEL,
    dimensions: positiveInt(options.dimensions) ?? positiveIntFromEnv("CODEXA_SEMANTIC_DIMENSIONS"),
    command: options.command ?? process.env.CODEXA_SEMANTIC_COMMAND,
    args: options.args ?? semanticArgsFromEnv(),
    timeoutMs: positiveInt(options.timeoutMs) ?? positiveIntFromEnv("CODEXA_SEMANTIC_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
    batchSize: positiveInt(options.batchSize) ?? positiveIntFromEnv("CODEXA_SEMANTIC_BATCH_SIZE") ?? DEFAULT_BATCH_SIZE
  };
}

function semanticProviderRunnable(provider: SemanticProviderKind, options: SemanticProviderOptions): boolean {
  if (provider === "openai") {
    return Boolean(process.env.OPENAI_API_KEY);
  }
  return Boolean(options.command);
}

function providerModel(provider: SemanticProviderKind, model: string | undefined): string {
  return model ?? (provider === "openai" ? DEFAULT_OPENAI_EMBEDDING_MODEL : "local-command");
}

function inferProviderFromEnvironment(enabled: boolean): SemanticProviderKind | undefined {
  if (!enabled) {
    return undefined;
  }
  if (process.env.CODEXA_SEMANTIC_COMMAND) {
    return "local-command";
  }
  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }
  return undefined;
}

function semanticEnabledOverride(value: boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const envValue = process.env.CODEXA_SEMANTIC?.trim().toLowerCase();
  if (!envValue || envValue === "auto") {
    return undefined;
  }
  if (envValue === "1" || envValue === "true" || envValue === "yes" || envValue === "on") {
    return true;
  }
  if (envValue === "0" || envValue === "false" || envValue === "no" || envValue === "off") {
    return false;
  }
  return undefined;
}

export function semanticProviderFromValue(value: string | undefined): SemanticProviderKind | undefined {
  if (value === "openai" || value === "local-command") {
    return value;
  }
  return undefined;
}

function semanticArgsFromEnv(): string[] | undefined {
  const value = process.env.CODEXA_SEMANTIC_ARGS_JSON;
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

function semanticSourceFingerprint(index: CodexaIndex, chunks: SemanticChunk[]): string {
  return createHash("sha256")
    .update(index.snapshot.snapshotId)
    .update("\n")
    .update(chunks.map((chunk) => `${chunk.path}:${hashText(chunk.text)}`).join("\n"))
    .digest("hex");
}

function semanticVectorFileName(input: { sourceFingerprint: string; provider: SemanticProviderKind; model: string; dimensions: number }): string {
  const fingerprint = createHash("sha256")
    .update(input.sourceFingerprint)
    .update("\n")
    .update(input.provider)
    .update("\n")
    .update(input.model)
    .update("\n")
    .update(String(input.dimensions))
    .digest("hex");
  return `vectors-${fingerprint.slice(0, 24)}.jsonl`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactPreview(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, MAX_PREVIEW_CHARS);
}

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.path) ?? [];
    list.push(item);
    grouped.set(item.path, list);
  }
  return grouped;
}

function moduleNameForPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) {
    return ".";
  }
  if (parts[0] === "src" && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? ".";
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function dot(a: number[], b: number[]): number {
  let score = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    score += a[i]! * b[i]!;
  }
  return score;
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const numbers = value.map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : Number.NaN));
  return numbers.every(Number.isFinite) ? numbers : null;
}

function isManifest(value: unknown): value is SemanticManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SemanticManifest>;
  return (
    record.schemaVersion === SEMANTIC_CACHE_VERSION &&
    typeof record.snapshotId === "string" &&
    typeof record.indexedAt === "string" &&
    (record.provider === "openai" || record.provider === "local-command") &&
    typeof record.model === "string" &&
    typeof record.dimensions === "number" &&
    typeof record.chunkCount === "number" &&
    isSemanticVectorFileName(record.vectorsFile) &&
    typeof record.sourceFingerprint === "string"
  );
}

function isSemanticVectorFileName(value: unknown): value is string {
  return value === VECTORS_FILE || (typeof value === "string" && /^vectors-[a-f0-9]{24}\.jsonl$/u.test(value));
}

function isVectorRecord(value: unknown): value is SemanticVectorRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SemanticVectorRecord>;
  return typeof record.id === "string" && typeof record.path === "string" && typeof record.title === "string" && typeof record.preview === "string" && Boolean(numberArray(record.embedding));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
