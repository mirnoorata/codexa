import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { recordSessionMemory } from "./session-memory.js";
import { workspaceStateDigest } from "./workspace-state.js";
import type {
  FreshnessInfo,
  VerificationArtifactLedgerEvidence,
  VerificationArtifactManifest,
  VerificationArtifactRecord,
  VerificationArtifactSummary
} from "./types.js";

export const VERIFICATION_ARTIFACT_DIR = ".codex/cache/codexa-verification-artifacts";
export const MAX_VERIFICATION_ARTIFACT_BYTES = 256 * 1024;
const MAX_STORED_ARTIFACT_BYTES = 512 * 1024;
const ARTIFACT_ID_PATTERN = /^va_[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;

const boundedId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:/-]+$/u);
const boundedLabel = z.string().trim().min(1).max(160);
const boundedSummary = z.string().trim().min(1).max(500);
const isoTimestamp = z.string().trim().max(80).refine((value) => Number.isFinite(Date.parse(value)), "expected an ISO timestamp");

const verificationArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("codexa-verification-summary"),
    binding: z
      .object({
        taskId: boundedId,
        headCommit: z.string().trim().toLowerCase().regex(COMMIT_PATTERN).nullable(),
        workspaceStateDigest: z.string().trim().toLowerCase().regex(SHA256_PATTERN)
      })
      .strict(),
    run: z
      .object({
        id: boundedId,
        category: boundedLabel,
        outcome: z.enum(["passed", "failed", "cancelled", "timed_out", "unknown"]),
        startedAt: isoTimestamp.optional(),
        finishedAt: isoTimestamp.optional(),
        durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            kind: z.enum(["workflow", "dependency"]),
            target: boundedId,
            outcome: z.enum(["passed", "failed", "skipped", "unknown"]),
            summary: boundedSummary.optional()
          })
          .strict()
      )
      .max(100),
    attachments: z
      .array(
        z
          .object({
            name: boundedLabel,
            sha256: z.string().trim().toLowerCase().regex(SHA256_PATTERN).optional(),
            sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
            mediaType: z.string().trim().min(1).max(120).optional()
          })
          .strict()
      )
      .max(40)
      .optional(),
    producer: z
      .object({
        name: boundedLabel,
        version: z.string().trim().min(1).max(80).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export interface VerificationArtifactLoadResult {
  artifactId: string;
  record?: VerificationArtifactRecord;
  status: "loaded" | "missing" | "invalid";
  reason?: string;
}

export interface VerificationArtifactIngestResult {
  record: VerificationArtifactRecord;
  relativePath: string;
  created: boolean;
  sessionMemoryRecorded: boolean;
  warnings: string[];
}

export interface VerificationArtifactEvaluation {
  selected: VerificationArtifactSummary[];
  accepted: VerificationArtifactSummary[];
  rejected: VerificationArtifactSummary[];
  ledgerEvidence: VerificationArtifactLedgerEvidence[];
}

export { workspaceStateDigest } from "./workspace-state.js";

export async function ingestVerificationArtifact(
  repoInput: string,
  sourceInput: string,
  options: { sessionId?: string; taskId?: string; freshness?: FreshnessInfo } = {}
): Promise<VerificationArtifactIngestResult> {
  const repoRoot = path.resolve(repoInput);
  const raw = await readBoundedRegularFile(path.resolve(sourceInput), MAX_VERIFICATION_ARTIFACT_BYTES, "verification artifact");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Verification artifact is not valid JSON");
  }
  const validation = verificationArtifactManifestSchema.safeParse(parsed);
  if (!validation.success) {
    const issue = validation.error.issues[0];
    throw new Error(`Verification artifact schema is invalid${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`);
  }
  const manifest = normalizeManifest(validation.data, repoRoot);
  if (options.taskId && options.taskId !== manifest.binding.taskId) {
    throw new Error(`Verification artifact task binding ${manifest.binding.taskId} does not match requested task ${options.taskId}`);
  }
  const artifactId = artifactIdForManifest(manifest);
  const record: VerificationArtifactRecord = {
    schemaVersion: 1,
    artifactId,
    ingestedAt: new Date().toISOString(),
    sourceSha256: sha256(raw),
    manifest
  };
  const cacheDir = await ensureArtifactCacheDir(repoRoot);
  const destination = path.join(cacheDir, `${artifactId}.json`);
  const existing = await loadVerificationArtifact(repoRoot, artifactId);
  let created = false;
  let effectiveRecord = record;
  if (existing.status === "loaded" && existing.record) {
    effectiveRecord = existing.record;
  } else {
    created = await atomicJsonWriteIfAbsent(destination, record);
    if (!created) {
      const winner = await loadVerificationArtifact(repoRoot, artifactId);
      if (winner.status !== "loaded" || !winner.record) {
        throw new Error(`Concurrent verification artifact publication produced an unreadable cache record: ${winner.reason ?? winner.status}`);
      }
      effectiveRecord = winner.record;
    }
  }

  const warnings: string[] = [];
  let sessionMemoryRecorded = false;
  if (options.sessionId && options.freshness) {
    try {
      await recordSessionMemory({
        repoRoot,
        sessionId: options.sessionId,
        taskId: manifest.binding.taskId,
        freshness: options.freshness,
        source: "codexa_cache",
        toolName: "verification_artifact",
        entries: [
          {
            kind: "verification",
            key: `run:${manifest.run.id}`,
            summary: `Verification artifact ${artifactId} reports run ${externalIdentifierRef(manifest.run.id)} ${manifest.run.outcome}.`,
            details: `category=${manifest.run.category}; workspaceState=${manifest.binding.workspaceStateDigest.slice(0, 12)}; checks=${manifest.checks.length}`,
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic",
            scope: {
              topics: [manifest.run.category],
              refs: [
                {
                  kind: "verification_artifact",
                  id: artifactId,
                  evidenceTier: "heuristic",
                  confidence: "heuristic"
                }
              ]
            }
          }
        ]
      });
      sessionMemoryRecorded = true;
    } catch (error) {
      warnings.push(`verification artifact session-memory record failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    record: effectiveRecord,
    relativePath: path.posix.join(VERIFICATION_ARTIFACT_DIR, `${artifactId}.json`),
    created,
    sessionMemoryRecorded,
    warnings
  };
}

export async function loadVerificationArtifact(repoInput: string, artifactIdInput: string): Promise<VerificationArtifactLoadResult> {
  const repoRoot = path.resolve(repoInput);
  const artifactId = artifactIdInput.trim();
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    return { artifactId, status: "invalid", reason: "artifact id is invalid" };
  }
  let cacheDir: string;
  try {
    cacheDir = await ensureArtifactCacheDir(repoRoot);
  } catch (error) {
    return { artifactId, status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const artifactPath = path.join(cacheDir, `${artifactId}.json`);
  let raw: Buffer;
  try {
    raw = await readBoundedRegularFile(artifactPath, MAX_STORED_ARTIFACT_BYTES, "stored verification artifact");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return {
      artifactId,
      status: code === "ENOENT" ? "missing" : "invalid",
      reason: code === "ENOENT" ? "artifact cache record is missing" : error instanceof Error ? error.message : String(error)
    };
  }
  try {
    const value = JSON.parse(raw.toString("utf8")) as Partial<VerificationArtifactRecord>;
    const validation = verificationArtifactManifestSchema.safeParse(value.manifest);
    if (
      value.schemaVersion !== 1 ||
      value.artifactId !== artifactId ||
      typeof value.ingestedAt !== "string" ||
      !Number.isFinite(Date.parse(value.ingestedAt)) ||
      typeof value.sourceSha256 !== "string" ||
      !SHA256_PATTERN.test(value.sourceSha256) ||
      !validation.success
    ) {
      return { artifactId, status: "invalid", reason: "artifact cache record schema is invalid" };
    }
    const manifest = normalizeManifest(validation.data, repoRoot);
    if (artifactIdForManifest(manifest) !== artifactId) {
      return { artifactId, status: "invalid", reason: "artifact cache record digest does not match its id" };
    }
    return {
      artifactId,
      status: "loaded",
      record: {
        schemaVersion: 1,
        artifactId,
        ingestedAt: value.ingestedAt,
        sourceSha256: value.sourceSha256,
        manifest
      }
    };
  } catch {
    return { artifactId, status: "invalid", reason: "artifact cache record is not valid JSON" };
  }
}

export async function loadVerificationArtifacts(repoRoot: string, artifactIds: string[]): Promise<VerificationArtifactLoadResult[]> {
  const uniqueIds = [...new Set(artifactIds.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
  return Promise.all(uniqueIds.map((artifactId) => loadVerificationArtifact(repoRoot, artifactId)));
}

export function evaluateVerificationArtifacts(
  loads: VerificationArtifactLoadResult[],
  input: {
    taskId?: string;
    freshness: FreshnessInfo;
    requiredChecks: Array<{ kind: "workflow" | "dependency"; target: string }>;
  }
): VerificationArtifactEvaluation {
  const stateDigest = workspaceStateDigest(input.freshness);
  const required = new Set(input.requiredChecks.map((check) => checkKey(check.kind, check.target)));
  const selected: VerificationArtifactSummary[] = [];
  const observations = new Map<string, Array<{ artifactId: string; positive: boolean; evidence: string }>>();

  for (const load of loads) {
    if (!load.record) {
      selected.push({
        artifactId: load.artifactId,
        status: load.status === "missing" ? "missing" : "invalid",
        trustTier: "none",
        reasons: [load.reason ?? `artifact ${load.status}`],
        checks: []
      });
      continue;
    }
    const { manifest } = load.record;
    const reasons = [
      ...(!input.taskId ? ["proof is not bound to a saved task"] : manifest.binding.taskId !== input.taskId ? [`task binding differs: ${manifest.binding.taskId}`] : []),
      ...(manifest.binding.headCommit !== input.freshness.headCommit ? ["head commit differs from the current worktree"] : []),
      ...(manifest.binding.workspaceStateDigest !== stateDigest ? ["workspace state digest differs from the current worktree"] : []),
      ...(input.freshness.stale ? [`current Codexa index is stale: ${input.freshness.reason}`] : [])
    ];
    const bound = reasons.length === 0;
    selected.push({
      artifactId: load.artifactId,
      runId: externalIdentifierRef(manifest.run.id),
      category: manifest.run.category,
      outcome: manifest.run.outcome,
      status: !bound ? "unbound" : manifest.run.outcome === "passed" ? "accepted" : "non_passing",
      // An unauthenticated manifest is durable and state-bound, but still
      // self-asserted evidence. Reserve stronger tiers for a future witnessed
      // or authenticated producer lane.
      trustTier: bound && manifest.run.outcome === "passed" ? "reported" : "none",
      reasons: manifest.run.outcome === "passed" ? reasons : [...reasons, `run outcome is ${manifest.run.outcome}`],
      checks: manifest.checks.map(({ kind, target, outcome }) => ({ kind, target, outcome }))
    });
    if (!bound) {
      continue;
    }
    for (const check of manifest.checks) {
      const key = checkKey(check.kind, check.target);
      if (!required.has(key)) {
        continue;
      }
      const positive = manifest.run.outcome === "passed" && check.outcome === "passed";
      const evidence = `${load.artifactId} reports run ${externalIdentifierRef(manifest.run.id)} ${manifest.run.outcome}; ${check.kind} ${check.target} ${check.outcome}`;
      observations.set(key, [...(observations.get(key) ?? []), { artifactId: load.artifactId, positive, evidence }]);
    }
  }

  const ledgerEvidence: VerificationArtifactLedgerEvidence[] = [];
  for (const check of input.requiredChecks) {
    const entries = observations.get(checkKey(check.kind, check.target)) ?? [];
    const positive = entries.filter((entry) => entry.positive);
    const negative = entries.filter((entry) => !entry.positive);
    if (positive.length > 0 && negative.length > 0) {
      ledgerEvidence.push({
        kind: check.kind,
        target: check.target,
        status: "conflicting",
        trustTier: "none",
        artifactIds: entries.map((entry) => entry.artifactId).sort(),
        evidence: entries.map((entry) => entry.evidence).sort()
      });
    } else if (positive.length > 0) {
      ledgerEvidence.push({
        kind: check.kind,
        target: check.target,
        status: "covered",
        trustTier: "reported",
        artifactIds: positive.map((entry) => entry.artifactId).sort(),
        evidence: positive.map((entry) => entry.evidence).sort()
      });
    }
  }
  const conflictedIds = new Set(ledgerEvidence.filter((entry) => entry.status === "conflicting").flatMap((entry) => entry.artifactIds));
  const withConflicts = selected.map((summary) =>
    conflictedIds.has(summary.artifactId)
      ? { ...summary, status: "conflicting" as const, trustTier: "none" as const, reasons: [...summary.reasons, "selected artifacts conflict for a required check"] }
      : summary
  );
  return {
    selected: withConflicts,
    accepted: withConflicts.filter((entry) => entry.status === "accepted"),
    rejected: withConflicts.filter((entry) => entry.status !== "accepted"),
    ledgerEvidence
  };
}

function normalizeManifest(value: VerificationArtifactManifest, repoRoot: string): VerificationArtifactManifest {
  const clean = (text: string, limit: number) => sanitizeText(text, repoRoot).slice(0, limit);
  return {
    schemaVersion: 1,
    kind: "codexa-verification-summary",
    binding: {
      taskId: value.binding.taskId,
      headCommit: value.binding.headCommit,
      workspaceStateDigest: value.binding.workspaceStateDigest
    },
    run: {
      id: value.run.id,
      category: clean(value.run.category, 160),
      outcome: value.run.outcome,
      startedAt: value.run.startedAt,
      finishedAt: value.run.finishedAt,
      durationMs: value.run.durationMs
    },
    checks: value.checks.map((check) => ({
      kind: check.kind,
      target: check.target,
      outcome: check.outcome,
      summary: check.summary ? clean(check.summary, 500) : undefined
    })),
    attachments: value.attachments?.map((attachment) => ({
      name: clean(attachment.name, 160),
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      mediaType: attachment.mediaType ? clean(attachment.mediaType, 120) : undefined
    })),
    producer: value.producer
      ? {
          name: clean(value.producer.name, 160),
          version: value.producer.version ? clean(value.producer.version, 80) : undefined
        }
      : undefined
  };
}

function artifactIdForManifest(manifest: VerificationArtifactManifest): string {
  return `va_${sha256(canonicalJson(manifest))}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeText(value: string, repoRoot: string): string {
  return value
    .replaceAll(repoRoot, "<repo>")
    .replace(/(\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*=)([^\s;|)\]"',]+)/giu, "$1<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 <redacted>")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function ensureArtifactCacheDir(repoRoot: string): Promise<string> {
  const repoReal = await fs.realpath(repoRoot).catch(() => "");
  if (!repoReal) {
    throw new Error("Verification artifact repository root does not exist");
  }
  const cacheDir = path.join(repoRoot, VERIFICATION_ARTIFACT_DIR);
  await fs.mkdir(cacheDir, { recursive: true });
  const cacheStat = await fs.lstat(cacheDir);
  const cacheReal = await fs.realpath(cacheDir);
  const relative = path.relative(repoReal, cacheReal);
  if (!cacheStat.isDirectory() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Verification artifact cache directory escapes the repository");
  }
  return cacheDir;
}

async function readBoundedRegularFile(filePath: string, limit: number, label: string): Promise<Buffer> {
  const beforeOpen = await fs.lstat(filePath);
  if (!beforeOpen.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${label} is not a regular file`);
    }
    if (stat.size > limit) {
      throw new Error(`${label} exceeds ${limit} bytes`);
    }
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit || bytesRead !== stat.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function atomicJsonWriteIfAbsent(filePath: string, value: unknown): Promise<boolean> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await fs.link(temp, filePath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EEXIST") {
        return false;
      }
      throw error;
    }
    return true;
  } catch (error) {
    throw error;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function checkKey(kind: "workflow" | "dependency", target: string): string {
  return `${kind}:${target}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function externalIdentifierRef(value: string): string {
  return `external_${sha256(value).slice(0, 12)}`;
}
