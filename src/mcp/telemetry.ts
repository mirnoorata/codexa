import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface McpOverheadTelemetryEvent {
  schemaVersion: 1;
  sequence: number;
  eventKind?: "tool" | "resource-read";
  logicalOperation?: string;
  outcome?: "ok" | "error";
  /** Number of events discarded before this one because the writer queue was full. */
  droppedBefore?: number;
  tool: string;
  profile: "core" | "full";
  requestedFormat: "auto" | "concise" | "detailed";
  effectiveFormat: "concise" | "detailed";
  escalationReason?: string;
  requestBytes: number;
  textBytes: number;
  structuredBytes: number;
  totalBytes: number;
  elapsedMs: number;
  resultReference?: string;
  unchangedReceipt: boolean;
}

/** Content-free proof that every accepted event reached the telemetry file. */
export interface McpOverheadTelemetryCompletionRecord {
  schemaVersion: 1;
  recordKind: "session-complete";
  sequence: number;
  eventCount: number;
}

const MAX_TELEMETRY_PATHS = 8;
const MAX_PENDING_EVENTS_PER_PATH = 256;
const MAX_PENDING_DATA_EVENTS_PER_PATH = MAX_PENDING_EVENTS_PER_PATH - 1;
const MAX_SERIALIZED_EVENT_BYTES = 16 * 1024;
const APPEND_BATCH_SIZE = 32;
// The benchmark reader accepts at most 1,000 records / 4 MiB. Reserve one
// record and one maximum-sized event for either a completion footer or an
// explicit partial-evidence marker.
const MAX_SESSION_DATA_RECORDS = 999;
const MAX_SESSION_DATA_BYTES = 4 * 1024 * 1024 - MAX_SERIALIZED_EVENT_BYTES;

type TelemetryWriter = {
  queue: string[];
  draining: boolean;
  disabled: boolean;
  accepting: boolean;
  finalized: boolean;
  sessionRecords: number;
  sessionBytes: number;
  lastSequence: number;
  capped: boolean;
  directoryReady: boolean;
  fileIdentity?: { dev: number; ino: number };
  finalization?: Promise<void>;
  waiters: Array<() => void>;
};

const telemetryWriters = new Map<string, TelemetryWriter>();

export function mcpTelemetryPath(repoRoot: string): string | undefined {
  const configured = process.env.CODEXA_MCP_TELEMETRY_PATH?.trim();
  if (!configured) {
    return undefined;
  }
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

/**
 * Enqueue an optional telemetry event without putting filesystem latency or
 * failure on the MCP response path. Queue overflow emits a terminal marker so
 * analyzers can mark the evidence partial without waiting for a later event.
 */
export function appendMcpOverheadTelemetry(repoRoot: string, event: McpOverheadTelemetryEvent): void {
  appendMcpOverheadTelemetryAtPath(mcpTelemetryPath(repoRoot), event);
}

/** Append to a destination resolved once by the owning MCP server. */
export function appendMcpOverheadTelemetryAtPath(filePath: string | undefined, event: McpOverheadTelemetryEvent): void {
  if (!filePath) {
    return;
  }
  const writer = telemetryWriter(filePath);
  if (!writer || writer.disabled || writer.capped || !writer.accepting) {
    return;
  }
  if (writer.queue.length >= MAX_PENDING_DATA_EVENTS_PER_PATH) {
    enqueueTerminalPartialMarker(filePath, writer, event, "writer-queue-overflow");
    return;
  }
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SERIALIZED_EVENT_BYTES) {
    enqueueTerminalPartialMarker(filePath, writer, event, "writer-event-oversized");
    return;
  }
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (writer.sessionRecords >= MAX_SESSION_DATA_RECORDS || writer.sessionBytes + lineBytes > MAX_SESSION_DATA_BYTES) {
    const marker: McpOverheadTelemetryEvent = {
      ...event,
      eventKind: "tool",
      logicalOperation: "writer-cap-reached",
      outcome: "error",
      droppedBefore: 1,
      tool: "telemetry",
      requestBytes: 0,
      textBytes: 0,
      structuredBytes: 0,
      totalBytes: 0,
      elapsedMs: 0,
      resultReference: undefined,
      unchangedReceipt: false
    };
    writer.queue.push(`${JSON.stringify(marker)}\n`);
    writer.capped = true;
    if (!writer.draining) {
      writer.draining = true;
      void drainTelemetryWriter(filePath, writer);
    }
    return;
  }
  writer.queue.push(line);
  writer.sessionRecords += 1;
  writer.sessionBytes += lineBytes;
  writer.lastSequence = event.sequence;
  if (!writer.draining) {
    writer.draining = true;
    void drainTelemetryWriter(filePath, writer);
  }
}

/**
 * Finish optional telemetry after the transport stops accepting work. The
 * completion record is deliberately emitted only here, never on a response
 * path. Its absence makes an otherwise valid prefix partial evidence.
 */
export async function finalizeMcpOverheadTelemetry(repoRoot: string): Promise<void> {
  await finalizeMcpOverheadTelemetryAtPath(mcpTelemetryPath(repoRoot));
}

/** Finalize only the destination owned by one MCP server. */
export async function finalizeMcpOverheadTelemetryAtPath(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  const writer = telemetryWriter(filePath);
  if (writer) await finalizeTelemetryWriter(filePath, writer);
}

function telemetryWriter(filePath: string): TelemetryWriter | undefined {
  let writer = telemetryWriters.get(filePath);
  if (writer) return writer;
  if (telemetryWriters.size >= MAX_TELEMETRY_PATHS) return undefined;
  writer = {
    queue: [],
    draining: false,
    disabled: false,
    accepting: true,
    finalized: false,
    sessionRecords: 0,
    sessionBytes: 0,
    lastSequence: 0,
    capped: false,
    directoryReady: false,
    waiters: []
  };
  telemetryWriters.set(filePath, writer);
  return writer;
}

function finalizeTelemetryWriter(filePath: string, writer: TelemetryWriter): Promise<void> {
  if (writer.finalization) return writer.finalization;
  writer.accepting = false;
  writer.finalization = (async () => {
    await waitForTelemetryWriter(writer);
    if (writer.disabled || writer.capped || writer.finalized) return;
    const completion: McpOverheadTelemetryCompletionRecord = {
      schemaVersion: 1,
      recordKind: "session-complete",
      sequence: writer.lastSequence + 1,
      eventCount: writer.sessionRecords
    };
    writer.queue.push(`${JSON.stringify(completion)}\n`);
    if (!writer.draining) {
      writer.draining = true;
      void drainTelemetryWriter(filePath, writer);
    }
    await waitForTelemetryWriter(writer);
    writer.finalized = !writer.disabled;
  })();
  return writer.finalization;
}

async function waitForTelemetryWriter(writer: TelemetryWriter): Promise<void> {
  while (writer.draining || writer.queue.length > 0) {
    await new Promise<void>((resolve) => writer.waiters.push(resolve));
  }
}

function enqueueTerminalPartialMarker(
  filePath: string,
  writer: TelemetryWriter,
  event: McpOverheadTelemetryEvent,
  logicalOperation: "writer-queue-overflow" | "writer-event-oversized"
): void {
  const marker: McpOverheadTelemetryEvent = {
    ...event,
    eventKind: "tool",
    logicalOperation,
    outcome: "error",
    droppedBefore: 1,
    tool: "telemetry",
    requestBytes: 0,
    textBytes: 0,
    structuredBytes: 0,
    totalBytes: 0,
    elapsedMs: 0,
    resultReference: undefined,
    unchangedReceipt: false
  };
  writer.queue.push(`${JSON.stringify(marker)}\n`);
  writer.capped = true;
  if (!writer.draining) {
    writer.draining = true;
    void drainTelemetryWriter(filePath, writer);
  }
}

async function drainTelemetryWriter(filePath: string, writer: TelemetryWriter): Promise<void> {
  try {
    if (!writer.directoryReady) {
      await ensureTelemetryDirectory(path.dirname(filePath));
      writer.directoryReady = true;
    }
    while (writer.queue.length > 0) {
      const batch = writer.queue.splice(0, APPEND_BATCH_SIZE).join("");
      await appendTelemetryBatch(filePath, writer, batch);
    }
  } catch (error) {
    // Telemetry is advisory. Disable this path after one failure so a broken
    // destination cannot create an error/log loop or affect tool delivery.
    writer.disabled = true;
    writer.queue.length = 0;
    console.error(`Codexa MCP telemetry write failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    writer.draining = false;
    const waiters = writer.waiters.splice(0);
    for (const resolve of waiters) resolve();
    if (!writer.disabled && writer.queue.length > 0) {
      writer.draining = true;
      void drainTelemetryWriter(filePath, writer);
    }
  }
}

async function ensureTelemetryDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = await fs.lstat(current).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("telemetry destination parent must not traverse a symbolic link");
    }
  }
}

async function appendTelemetryBatch(filePath: string, writer: TelemetryWriter, batch: string): Promise<void> {
  const appendFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: FileHandle;
  try {
    handle = await fs.open(
      filePath,
      appendFlags | (writer.fileIdentity ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600
    );
  } catch (error) {
    if (!writer.fileIdentity && errorCode(error) === "EEXIST") {
      throw new Error("telemetry destination must be absent at MCP server start; use a unique path per server session");
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("telemetry destination must be one regular, non-hardlinked file");
    }
    if (writer.fileIdentity && (stat.dev !== writer.fileIdentity.dev || stat.ino !== writer.fileIdentity.ino)) {
      throw new Error("telemetry destination changed during the MCP session");
    }
    const openedPath = process.platform === "linux"
      ? await fs.realpath(`/proc/self/fd/${handle.fd}`)
      : await fs.realpath(filePath);
    if (openedPath !== path.resolve(filePath)) {
      throw new Error("telemetry destination traverses a symbolic-link parent");
    }
    writer.fileIdentity ??= { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(batch, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/** Test-only drain hook; production delivery never awaits telemetry. */
export async function flushMcpOverheadTelemetry(): Promise<void> {
  while (true) {
    const pending = [...telemetryWriters.values()].filter((writer) => writer.draining || writer.queue.length > 0);
    if (pending.length === 0) return;
    await Promise.all(
      pending.map(
        (writer) =>
          new Promise<void>((resolve) => {
            if (!writer.draining && writer.queue.length === 0) resolve();
            else writer.waiters.push(resolve);
          })
      )
    );
  }
}

/** Test-only reset. Call only after flushMcpOverheadTelemetry(). */
export function resetMcpOverheadTelemetryForTests(): void {
  telemetryWriters.clear();
}

export function mcpToolResultByteCounts(result: { content?: unknown; structuredContent?: unknown }): { textBytes: number; structuredBytes: number; totalBytes: number } {
  const content = Array.isArray(result.content) ? result.content : [];
  const textBytes = content.reduce((total, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || (entry as Record<string, unknown>).type !== "text") {
      return total;
    }
    const value = (entry as Record<string, unknown>).text;
    return total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
  }, 0);
  const structuredBytes = result.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8");
  const totalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  return { textBytes, structuredBytes, totalBytes };
}

/** Report the format that crossed the transport boundary after final budgeting. */
export function mcpToolResultEffectiveFormat(
  result: { structuredContent?: unknown },
  fallback: "concise" | "detailed"
): "concise" | "detailed" {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const data = isRecord(structured?.data) ? structured.data : undefined;
  const delivery = isRecord(data?.delivery) ? data.delivery : undefined;
  return delivery?.effectiveFormat === "concise" || delivery?.effectiveFormat === "detailed"
    ? delivery.effectiveFormat
    : fallback;
}

/** Report the final delivery reason, including transport-budget compaction. */
export function mcpToolResultEscalationReason(
  result: { structuredContent?: unknown },
  fallback?: string
): string | undefined {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const data = isRecord(structured?.data) ? structured.data : undefined;
  const delivery = isRecord(data?.delivery) ? data.delivery : undefined;
  return typeof delivery?.escalationReason === "string" ? delivery.escalationReason : fallback;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
