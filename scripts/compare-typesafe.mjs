// Fixed synthetic holdout: no private repository source is sent to the service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndexLocked } from "../dist/indexer.js";
import { findContextQuery } from "../dist/query/search.js";
import { createQuerySessionFromIndexState } from "../dist/query/session.js";

const groups = [
  {
    target: "retry_delay.ts", decoy: "retry_guide.ts",
    source: "export function scheduleAttempt(attempt: number, random: number) { return Math.min(60000, 100 * 2 ** attempt) * (0.5 + random / 2); }",
    prose: "retry scheduling delay backoff jitter exponential failure attempts",
    queries: ["where is the retry delay increased exponentially and capped", "find the retry scheduling code that adds randomness between failed attempts"]
  },
  {
    target: "session_guard.ts", decoy: "session_catalog.ts",
    source: "export function allowSession(session: { expiresAt: number } | undefined, now: number) { if (!session || now >= session.expiresAt) return false; return true; }",
    prose: "session guard expiry expiration expired authentication access reject",
    queries: ["where does an expired session get rejected", "find the session access check that compares its expiration to the current time"]
  },
  {
    target: "payment_merge.ts", decoy: "payment_notes.ts",
    source: "export function acceptPayment(seen: Set<string>, id: string, apply: () => void) { if (seen.has(id)) return false; seen.add(id); apply(); return true; }",
    prose: "payment duplicate deduplication idempotency repeated event merge prevention",
    queries: ["where are repeated payment events prevented from applying twice", "find payment processing that checks an already seen identifier"]
  },
  {
    target: "queue_limit.ts", decoy: "queue_manual.ts",
    source: "export async function drainQueue<T>(items: T[], maximum: number, run: (item: T) => Promise<void>) { let cursor = 0; await Promise.all(Array.from({ length: maximum }, async () => { while (cursor < items.length) { const item = items[cursor++]; await run(item); } })); }",
    prose: "queue concurrency maximum parallel workers scheduling jobs limit",
    queries: ["where is the maximum number of simultaneous queue jobs enforced", "find the queue workers that share a cursor and await each job"]
  },
  {
    target: "cache_expiry.ts", decoy: "cache_reference.ts",
    source: "export function readEntry<T>(cache: Map<string, { value: T; until: number }>, key: string, now: number) { const item = cache.get(key); if (!item) return undefined; if (now >= item.until) { cache.delete(key); return undefined; } return item.value; }",
    prose: "cache expiry stale entries expired eviction lookup freshness deletion",
    queries: ["where are expired cache entries deleted during lookup", "find the cache lookup that returns no value after its deadline"]
  },
  {
    target: "output_escape.ts", decoy: "output_catalog.ts",
    source: "export function encodeOutput(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;'); }",
    prose: "output HTML escape encoding markup quotes angle brackets ampersand",
    queries: ["where does output encoding replace angle brackets and ampersands", "find the output function that converts quotes into HTML entities"]
  }
];
const cases = groups.flatMap((group) => [
  ...group.queries.map((query) => ({ query, target: group.target, kind: "behavior" })),
  { query: group.target, target: group.target, kind: "exact" }
]);
const fixtureHash = createHash("sha256").update(JSON.stringify(groups)).digest("hex");
const live = process.argv.includes("--live");
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(outputIndex < 0 ? ".codex/cache/typesafe-comparison.json" : process.argv[outputIndex + 1]);
if (live && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY in the process environment before --live.");
const root = await mkdtemp(path.join(os.tmpdir(), "codexa-typesafe-comparison-"));
const results = [];
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { requests++; return originalFetch(...args); };
try {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  for (const group of groups) {
    await writeFile(path.join(root, group.target), `${group.source}\n`);
    await writeFile(path.join(root, group.decoy), `// Reference vocabulary: ${group.prose}\nexport const topics = ${JSON.stringify(group.prose.split(" "))};\n`);
  }
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixed synthetic comparison"], { cwd: root, stdio: "ignore" });
  const index = await buildIndexLocked({ repoRoot: root, writeArtifacts: true });
  const session = createQuerySessionFromIndexState(root, { index, freshness: index.freshness });
  // One local warmup only; API requests are limited to one per case.
  await findContextQuery(session, cases[0].query, 8, { semantic: false, typesafe: false });
  for (const [position, item] of cases.entries()) {
    const run = async (enabled) => {
      const start = performance.now();
      const result = await findContextQuery(session, item.query, 8, {
        semantic: false, typesafe: enabled, typesafeTimeoutMs: 2500, typesafeMaxCandidates: 8
      });
      const paths = result.data.files.map((file) => file.path);
      return { paths, rank: paths.indexOf(item.target) + 1, latencyMs: performance.now() - start,
        typesafe: result.data.retrieval.typesafe, intent: result.data.retrieval.intentConfidence };
    };
    // Alternate order to reduce warm-cache bias; no online tuning of the fixture.
    let baseline, candidate;
    if (position % 2 && live) { candidate = await run(true); baseline = await run(false); }
    else { baseline = await run(false); candidate = live ? await run(true) : undefined; }
    if (candidate) {
      assert.deepEqual(candidate.intent, baseline.intent, "TypeSafe must not change edit authority");
      assert.deepEqual([...candidate.paths].sort(), [...baseline.paths].sort(), "TypeSafe must preserve candidates");
    }
    let repeat;
    if (candidate && ["ok", "skipped"].includes(candidate.typesafe.status)) {
      const beforeRepeat = requests;
      repeat = await run(true);
      assert.equal(requests, beforeRepeat, "An unchanged accepted/exact query must not call TypeSafe again");
      assert.deepEqual(repeat.paths, candidate.paths, "Reuse must preserve the accepted order");
      assert.deepEqual(repeat.intent, candidate.intent, "Reuse must preserve edit authority");
      if (candidate.typesafe.status === "ok") assert.equal(repeat.typesafe.cacheHit, true);
    }
    results.push({ ...item, baseline, candidate, repeat });
    console.log(`${position + 1}/${cases.length} ${item.kind}: baseline rank ${baseline.rank || "absent"}${candidate ? `; TypeSafe rank ${candidate.rank || "absent"} (${candidate.typesafe.status})` : ""}`);
  }
  const summary = {};
  for (const kind of ["all", "behavior", "exact"]) {
    const selected = results.filter((item) => kind === "all" || item.kind === kind);
    summary[kind] = Object.fromEntries(["baseline", ...(live ? ["candidate", "repeat"] : [])].map((mode) => {
      const rows = selected.map((item) => item[mode]).filter(Boolean);
      const times = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
      return [mode, {
        cases: rows.length, top1: rows.filter((row) => row.rank === 1).length / rows.length,
        mrr: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
        recall: rows.filter((row) => row.rank > 0).length / rows.length,
        medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
        statuses: rows.reduce((counts, row) => { const status = row.typesafe.status; counts[status] = (counts[status] ?? 0) + 1; return counts; }, {}),
        inputTokens: rows.reduce((sum, row) => sum + (row.typesafe.inputTokens ?? 0), 0),
        outputTokens: rows.reduce((sum, row) => sum + (row.typesafe.outputTokens ?? 0), 0)
      }];
    }));
  }
  const report = { schemaVersion: 2, fixtureHash, generatedAt: new Date().toISOString(), live, requests, node: process.version,
    settings: { model: "jev-latest", deadlineMs: 2500, maxCandidates: 8, requestCap: cases.length }, summary, results };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report saved to ${output}`);
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
