import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** Read-only inputs: never installs dependencies or executes repository code. */
export async function loadTypeSafeEvalPack(filename, checkoutDirectory) {
  const bytes = await readFile(filename);
  const pack = JSON.parse(bytes);
  assert.equal(pack.schemaVersion, 1, "unsupported retrieval pack version");
  assert(Array.isArray(pack.repositories) && pack.repositories.length > 0 && pack.repositories.length <= 20);
  assert(Array.isArray(pack.cases) && pack.cases.length > 0 && pack.cases.length <= 200);
  const repositories = new Map();
  const identities = new Set();
  const base = await realpath(checkoutDirectory);
  for (const repository of pack.repositories) {
    assert(/^[a-zA-Z0-9_-]+$/u.test(repository.id), "invalid repository id");
    assert(!repositories.has(repository.id), "duplicate repository id");
    assert(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(repository.url), "use a public GitHub repository URL without .git");
    const identity = repository.url.toLowerCase().replace(/\.git$/u, "");
    assert(!identities.has(identity), "repository cannot occur in both partitions or under aliases");
    identities.add(identity);
    assert(["calibration", "evaluation"].includes(repository.partition));
    assert(/^[a-f0-9]{40}$/u.test(repository.commit), "pin an exact repository revision");
    const root = await realpath(path.join(base, repository.id));
    assert(root.startsWith(base + path.sep), "checkout must remain inside checkout directory");
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.equal(await realpath(git("rev-parse", "--show-toplevel")), root, "use a separate repository checkout");
    assert.equal(git("rev-parse", "HEAD"), repository.commit, "checkout revision differs from pack");
    assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "tracked evaluation source must be clean");
    assert.equal(git("ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).codex"), "", "untracked evaluation source must be clean");
    const origin = git("remote", "get-url", "origin").toLowerCase().replace(/\.git$/u, "");
    assert.equal(origin, identity, "checkout origin differs from pack");
    repositories.set(repository.id, { ...repository, root });
  }
  const ids = new Set();
  for (const item of pack.cases) {
    assert(typeof item.id === "string" && /^[a-z0-9-]{1,80}$/u.test(item.id) && !ids.has(item.id), "case ids must be unique");
    ids.add(item.id);
    const repository = repositories.get(item.repository);
    assert(repository, "unknown case repository");
    assert(typeof item.query === "string" && item.query.trim() && item.query.length <= 4096);
    assert(["behavior", "exact"].includes(item.kind));
    assert(typeof item.target === "string" && !path.isAbsolute(item.target) && !item.target.split(/[\\/]/u).includes(".."));
    const target = await realpath(path.join(repository.root, item.target));
    assert(target.startsWith(repository.root + path.sep), "target escapes checkout");
    execFileSync("git", ["-C", repository.root, "ls-files", "--error-unmatch", "--", item.target], { stdio: "ignore" });
    const lines = (await readFile(target, "utf8")).split("\n");
    assert(Number.isSafeInteger(item.line) && item.line > 0 && item.line <= lines.length, "invalid expected source line");
  }
  return { repositories, cases: pack.cases, fixtureHash: createHash("sha256").update(bytes).digest("hex") };
}

export function summarizeRetrievalRows(rows) {
  if (!rows.length) return { cases: 0 };
  const times = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  const usage = key => rows.some(row => row.typesafe.requestAttempted !== false && !Number.isFinite(row.typesafe[key]))
    ? null : rows.reduce((total, row) => total + (row.typesafe[key] ?? 0), 0);
  return {
    cases: rows.length, top1: rows.filter(row => row.rank === 1).length / rows.length,
    mrr: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
    candidateRecall: rows.filter(row => row.rank > 0).length / rows.length,
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * .95) - 1],
    requests: rows.some(row => typeof row.typesafe.requestAttempted !== "boolean") ? null : rows.filter(row => row.typesafe.requestAttempted).length,
    cacheHits: rows.filter(row => row.typesafe.cacheHit).length,
    orderChanges: rows.filter(row => row.typesafe.orderChanged).length,
    statuses: rows.reduce((counts, row) => { counts[row.typesafe.status] = (counts[row.typesafe.status] ?? 0) + 1; return counts; }, {}),
    inputTokens: usage("inputTokens"), outputTokens: usage("outputTokens"), costUsd: null
  };
}
