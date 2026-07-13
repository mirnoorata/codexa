import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateVerificationArtifacts,
  ingestVerificationArtifact,
  loadVerificationArtifact,
  workspaceStateDigest
} from "../src/verification-artifacts.js";
import { readSessionMemory } from "../src/session-memory.js";
import type { FreshnessInfo, VerificationArtifactManifest } from "../src/types.js";

describe("verification artifacts", () => {
  it("computes a stable workspace digest independent of dirty-file map insertion order", () => {
    const left = freshness({ dirtyFileHashes: { "src/b.ts": "b", "src/a.ts": "a" } });
    const right = freshness({ dirtyFileHashes: { "src/a.ts": "a", "src/b.ts": "b" } });
    expect(workspaceStateDigest(left)).toBe(workspaceStateDigest(right));
    expect(workspaceStateDigest(freshness({ dirtyFileHashes: { "src/a.ts": "changed", "src/b.ts": "b" } }))).not.toBe(workspaceStateDigest(left));
  });

  it("ingests a strict generic manifest and credits only exact state-bound required checks", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-artifact-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-source-"));
    try {
      const current = freshness();
      const source = path.join(sourceDir, "summary.json");
      await writeFile(source, JSON.stringify(manifest(current)), "utf8");

      const ingested = await ingestVerificationArtifact(repo, source);
      expect(ingested.record.artifactId).toMatch(/^va_[a-f0-9]{64}$/u);
      expect(ingested.relativePath).not.toContain(sourceDir);
      expect(ingested.record.manifest.checks[0].summary).toContain("<redacted>");

      const loaded = await loadVerificationArtifact(repo, ingested.record.artifactId);
      const evaluation = evaluateVerificationArtifacts([loaded], {
        taskId: "task-1",
        freshness: current,
        requiredChecks: [
          { kind: "workflow", target: "live-smoke" },
          { kind: "dependency", target: "not-in-artifact" }
        ]
      });
      expect(evaluation.accepted).toHaveLength(1);
      expect(evaluation.ledgerEvidence).toEqual([
        expect.objectContaining({ kind: "workflow", target: "live-smoke", status: "covered", trustTier: "reported" })
      ]);
      expect(evaluation.ledgerEvidence.some((entry) => entry.target === "not-in-artifact")).toBe(false);

      const memoryIngest = await ingestVerificationArtifact(repo, source, {
        sessionId: "artifact-session",
        taskId: "task-1",
        freshness: current
      });
      expect(memoryIngest.sessionMemoryRecorded).toBe(true);
      const memory = await readSessionMemory({ repoRoot: repo, sessionId: "artifact-session", taskId: "task-1", freshness: current });
      expect(memory.memory.verification[0]).toMatchObject({ provenance: "agent-asserted", confidence: "heuristic", evidenceTier: "heuristic", key: "run:run-12" });
      expect(memory.memory.verification[0].scope.refs).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "verification_artifact", id: ingested.record.artifactId })])
      );

      const concurrentSource = path.join(sourceDir, "concurrent.json");
      await writeFile(concurrentSource, JSON.stringify({ ...manifest(current), run: { ...manifest(current).run, id: "run-concurrent" } }), "utf8");
      const concurrent = await Promise.all([ingestVerificationArtifact(repo, concurrentSource), ingestVerificationArtifact(repo, concurrentSource)]);
      expect(concurrent.filter((entry) => entry.created)).toHaveLength(1);
      expect(new Set(concurrent.map((entry) => entry.record.ingestedAt)).size).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("fails closed for state drift, conflicts, malformed input, symlinks, and cache tampering", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-boundary-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-boundary-source-"));
    try {
      const current = freshness();
      const passPath = path.join(sourceDir, "pass.json");
      const failPath = path.join(sourceDir, "fail.json");
      await writeFile(passPath, JSON.stringify(manifest(current)), "utf8");
      await writeFile(
        failPath,
        JSON.stringify({ ...manifest(current), run: { ...manifest(current).run, id: "run-failed", outcome: "failed" } }),
        "utf8"
      );
      const passed = await ingestVerificationArtifact(repo, passPath);
      const failed = await ingestVerificationArtifact(repo, failPath);
      const failedOnly = evaluateVerificationArtifacts([await loadVerificationArtifact(repo, failed.record.artifactId)], {
        taskId: "task-1",
        freshness: current,
        requiredChecks: [{ kind: "workflow", target: "live-smoke" }]
      });
      expect(failedOnly.selected[0]).toMatchObject({ status: "non_passing", trustTier: "none" });
      expect(failedOnly.ledgerEvidence).toEqual([]);
      const conflict = evaluateVerificationArtifacts(
        [await loadVerificationArtifact(repo, passed.record.artifactId), await loadVerificationArtifact(repo, failed.record.artifactId)],
        { taskId: "task-1", freshness: current, requiredChecks: [{ kind: "workflow", target: "live-smoke" }] }
      );
      expect(conflict.ledgerEvidence[0]).toMatchObject({ status: "conflicting", trustTier: "none" });
      expect(conflict.selected.find((entry) => entry.artifactId === failed.record.artifactId)).toMatchObject({ status: "conflicting", trustTier: "none" });

      const drifted = evaluateVerificationArtifacts([await loadVerificationArtifact(repo, passed.record.artifactId)], {
        taskId: "task-1",
        freshness: freshness({ dirtyFileHashes: { "src/app.ts": "new-hash" } }),
        requiredChecks: [{ kind: "workflow", target: "live-smoke" }]
      });
      expect(drifted.rejected[0]).toMatchObject({ status: "unbound", trustTier: "none" });

      const malformed = path.join(sourceDir, "malformed.json");
      await writeFile(malformed, JSON.stringify({ ...manifest(current), extra: "not allowed" }), "utf8");
      await expect(ingestVerificationArtifact(repo, malformed)).rejects.toThrow(/schema is invalid/u);

      const linked = path.join(sourceDir, "linked.json");
      await symlink(passPath, linked);
      await expect(ingestVerificationArtifact(repo, linked)).rejects.toThrow();

      const fifo = path.join(sourceDir, "summary.fifo");
      execFileSync("mkfifo", [fifo]);
      const fifoStarted = Date.now();
      await expect(ingestVerificationArtifact(repo, fifo)).rejects.toThrow(/not a regular file/u);
      expect(Date.now() - fifoStarted).toBeLessThan(1000);

      const storedPath = path.join(repo, ".codex/cache/codexa-verification-artifacts", `${passed.record.artifactId}.json`);
      const stored = JSON.parse(await readFile(storedPath, "utf8")) as { manifest: { run: { id: string } } };
      stored.manifest.run.id = "tampered";
      await writeFile(storedPath, JSON.stringify(stored), "utf8");
      expect(await loadVerificationArtifact(repo, passed.record.artifactId)).toMatchObject({ status: "invalid", reason: expect.stringContaining("digest") });
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

function freshness(overrides: Partial<FreshnessInfo> = {}): FreshnessInfo {
  const dirtyFileHashes = overrides.dirtyFileHashes ?? { "src/app.ts": "app-hash" };
  return {
    schemaVersion: 1,
    snapshotId: overrides.snapshotId ?? "snapshot-1",
    repoRoot: overrides.repoRoot ?? "/tmp/repo",
    gitRoot: overrides.gitRoot ?? "/tmp/repo",
    headCommit: overrides.headCommit ?? "abcdef1234567890",
    indexedAt: overrides.indexedAt ?? "2026-07-12T00:00:00.000Z",
    dirtyFiles: overrides.dirtyFiles ?? Object.keys(dirtyFileHashes),
    dirtyFileHashes,
    indexedDirtyFiles: overrides.indexedDirtyFiles ?? Object.keys(dirtyFileHashes),
    indexedDirtyFileHashes: overrides.indexedDirtyFileHashes ?? dirtyFileHashes,
    missing: false,
    stale: overrides.stale ?? false,
    reason: overrides.reason ?? "fresh",
    parserErrorCount: 0
  };
}

function manifest(current: FreshnessInfo): VerificationArtifactManifest {
  return {
    schemaVersion: 1,
    kind: "codexa-verification-summary",
    binding: {
      taskId: "task-1",
      headCommit: current.headCommit,
      workspaceStateDigest: workspaceStateDigest(current)
    },
    run: {
      id: "run-12",
      category: "live-validation",
      outcome: "passed",
      durationMs: 1200
    },
    checks: [
      {
        kind: "workflow",
        target: "live-smoke",
        outcome: "passed",
        summary: "Bearer secret-token completed"
      }
    ],
    attachments: [{ name: "events", sha256: "a".repeat(64), sizeBytes: 42, mediaType: "application/jsonl" }],
    producer: { name: "generic-live-runner", version: "1.0" }
  };
}
