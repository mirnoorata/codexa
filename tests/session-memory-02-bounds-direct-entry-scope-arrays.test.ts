import { mkdir, readFile, readdir, rm, writeFile, mkdtemp, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireCacheLock } from "../src/cache-lock.js";
import {
  SESSION_MEMORY_LOCK_DIR,
  compactSessionMemory,
  readSessionMemory,
  recordViewedMemoryForTool,
  recordSessionMemory,
  sessionMemoryCacheDir,
  summarizeSessionMemory
} from "../src/session-memory.js";
import { CURRENT_VERIFICATION_PROVENANCE, type CodexaIndex, type FileFact, type FreshnessInfo, type QueryResult, type RepoSnapshotFact } from "../src/types.js";
import { indexFixture, fileFixture, freshnessFixture } from "./session-memory-fixtures.js";
describe("session memory storage", () => {
it("bounds direct entry scope arrays before writing cache state", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-bounds-"));
    const freshness = freshnessFixture("snap-bounds");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-bounds",
      freshness,
      entries: [
        {
          kind: "claim",
          summary: "Large direct scopes are bounded.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "heuristic",
          scope: {
            files: Array.from({ length: 120 }, (_, index) => `src/${index}-${"x".repeat(600)}.ts`),
            symbols: Array.from({ length: 120 }, (_, index) => `symbol-${index}-${"x".repeat(300)}`),
            topics: Array.from({ length: 60 }, (_, index) => `topic-${index}`)
          }
        }
      ]
    });

    const memory = await readSessionMemory({ repoRoot: repo, sessionId: "sid-bounds", freshness });
    const entry = memory.memory.claims[0];
    expect(entry.scope.files).toHaveLength(80);
    expect(entry.scope.symbols).toHaveLength(80);
    expect(entry.scope.topics).toHaveLength(40);
    expect(entry.scope.files.every((file) => file.length <= 500)).toBe(true);
    expect(entry.scope.symbols.every((symbol) => symbol.length <= 240)).toBe(true);
  });

it("compacts events deterministically and drops resolved entries only after writing a compaction artifact", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-compact-"));
    const freshness = freshnessFixture("snap-1");
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-compact",
      freshness,
      entries: [
        {
          kind: "open_question",
          key: "question:active",
          summary: "Which tests cover session memory?",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "heuristic"
        },
        {
          kind: "open_question",
          key: "question:resolved",
          summary: "Resolved question.",
          status: "resolved",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "heuristic"
        }
      ]
    });

    const compacted = await compactSessionMemory({ repoRoot: repo, sessionId: "sid-compact", freshness });
    expect(compacted.writes?.compacted).toBe(true);
    expect(compacted.memory.openQuestions.map((entry) => entry.summary)).toEqual(["Which tests cover session memory?"]);

    const sessionDir = path.join(sessionMemoryCacheDir(repo), "sessions/sid-compact");
    const compactions = await readdir(path.join(sessionDir, "compactions"));
    expect(compactions.length).toBe(1);
    const events = (await readFile(path.join(sessionDir, "events.ndjson"), "utf8")).trim().split(/\r?\n/u);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("\"event\":\"compact\"");
    const files = await readdir(sessionDir);
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

it("times out on a live cache lock instead of stealing it", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-lock-"));
    const release = await acquireCacheLock({
      repoRoot: repo,
      lockDir: SESSION_MEMORY_LOCK_DIR,
      staleMs: 60_000,
      timeoutMs: 1_000,
      label: "test held lock"
    });

    try {
      await expect(
        acquireCacheLock({
          repoRoot: repo,
          lockDir: SESSION_MEMORY_LOCK_DIR,
          staleMs: 60_000,
          timeoutMs: 10,
          label: "test contended lock"
        })
      ).rejects.toThrow("Timed out waiting for test contended lock");
    } finally {
      await release();
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("does not steal a live holder whose lock was refreshed within the recovery ceiling", async () => {
    // owner.pid is this (live) process and owner.json was written (mtime) 30s ago,
    // well within the hard recovery ceiling (staleMs*8 = 80s). This models a
    // transient stall — stealing it would let two processes hold the lock, so
    // acquisition must time out and leave the original owner untouched.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-stale-live-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    const ownerPath = path.join(lockDir, "owner.json");
    const now = new Date().toISOString();
    await writeFile(
      ownerPath,
      `${JSON.stringify({ pid: process.pid, token: "stale-live-owner", processStartTime: null, startedAt: now, heartbeatAt: now, repoRoot: repo })}\n`,
      "utf8"
    );
    const thirtySecondsAgo = new Date(Date.now() - 30_000);
    await utimes(ownerPath, thirtySecondsAgo, thirtySecondsAgo);

    try {
      await expect(
        acquireCacheLock({
          repoRoot: repo,
          lockDir: SESSION_MEMORY_LOCK_DIR,
          staleMs: 10_000,
          timeoutMs: 200,
          label: "test stale live lock"
        })
      ).rejects.toThrow("Timed out waiting for test stale live lock");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: string };
      expect(owner.token).toBe("stale-live-owner");
    } finally {
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("reclaims a live-looking lock not refreshed beyond the ceiling, even with a future-dated heartbeat", async () => {
    // A wedged holder (or a recycled PID not updating this lock) stops rewriting
    // owner.json, so its file mtime freezes. Past the hard ceiling the lock is
    // unrecoverable and must be reclaimed — the frozen file mtime is authoritative
    // even when the heartbeat CONTENT is future-dated (clock skew can't shield a
    // genuinely abandoned lock from recovery).
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-frozen-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    const ownerPath = path.join(lockDir, "owner.json");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(
      ownerPath,
      `${JSON.stringify({ pid: process.pid, token: "frozen-owner", processStartTime: null, startedAt: future, heartbeatAt: future, repoRoot: repo })}\n`,
      "utf8"
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(ownerPath, longAgo, longAgo);

    const release = await acquireCacheLock({
      repoRoot: repo,
      lockDir: SESSION_MEMORY_LOCK_DIR,
      staleMs: 1,
      timeoutMs: 1_000,
      label: "test frozen lock"
    });
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: string };
      expect(owner.token).not.toBe("frozen-owner");
    } finally {
      await release();
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("reclaims a live-looking lock not refreshed beyond the ceiling, even with a corrupt heartbeat field", async () => {
    // The frozen file mtime drives recovery, so a damaged/garbage heartbeat field
    // cannot shield an abandoned lock from reclaim either.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-frozen-corrupt-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    const ownerPath = path.join(lockDir, "owner.json");
    await writeFile(
      ownerPath,
      `${JSON.stringify({ pid: process.pid, token: "frozen-corrupt-owner", processStartTime: null, startedAt: new Date().toISOString(), heartbeatAt: "not-a-date", repoRoot: repo })}\n`,
      "utf8"
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(ownerPath, longAgo, longAgo);

    const release = await acquireCacheLock({
      repoRoot: repo,
      lockDir: SESSION_MEMORY_LOCK_DIR,
      staleMs: 1,
      timeoutMs: 1_000,
      label: "test frozen corrupt lock"
    });
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: string };
      expect(owner.token).not.toBe("frozen-corrupt-owner");
    } finally {
      await release();
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("does not steal a freshly-refreshed live holder whose heartbeat content is future-dated (clock skew)", async () => {
    // A live holder with a clock that runs ahead writes a future-dated heartbeat,
    // but keeps owner.json's mtime fresh. The fresh mtime (not the content) governs
    // recovery, so the holder is respected. A ceiling far larger than the timeout
    // keeps the static fixture from aging out mid-test.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-future-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "future-owner", processStartTime: null, startedAt: future, heartbeatAt: future, repoRoot: repo })}\n`,
      "utf8"
    );

    try {
      await expect(
        acquireCacheLock({
          repoRoot: repo,
          lockDir: SESSION_MEMORY_LOCK_DIR,
          staleMs: 60_000,
          timeoutMs: 200,
          label: "test future lock"
        })
      ).rejects.toThrow("Timed out waiting for test future lock");
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { token?: string };
      expect(owner.token).toBe("future-owner");
    } finally {
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("does not steal a freshly-refreshed live holder whose heartbeat field is corrupt", async () => {
    // A fresh mtime means the holder is actively refreshing the lock; a damaged
    // heartbeat field alone is no evidence of a wedge and must not cause a steal.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-corrupt-hb-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "corrupt-hb-owner", processStartTime: null, startedAt: "2000-01-01T00:00:00.000Z", heartbeatAt: "not-a-date", repoRoot: repo })}\n`,
      "utf8"
    );

    try {
      await expect(
        acquireCacheLock({
          repoRoot: repo,
          lockDir: SESSION_MEMORY_LOCK_DIR,
          staleMs: 60_000,
          timeoutMs: 200,
          label: "test corrupt hb lock"
        })
      ).rejects.toThrow("Timed out waiting for test corrupt hb lock");
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { token?: string };
      expect(owner.token).toBe("corrupt-hb-owner");
    } finally {
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });

it("reclaims a lock whose owning process is gone", async () => {
    // A genuinely dead owner (pid not running) is safe to reclaim immediately.
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-dead-lock-"));
    const lockDir = path.join(repo, SESSION_MEMORY_LOCK_DIR);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 2_147_483_646,
        token: "dead-owner",
        processStartTime: null,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        repoRoot: repo
      })}\n`,
      "utf8"
    );

    const release = await acquireCacheLock({
      repoRoot: repo,
      lockDir: SESSION_MEMORY_LOCK_DIR,
      staleMs: 60_000,
      timeoutMs: 1_000,
      label: "test dead lock"
    });
    try {
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { token?: string };
      expect(owner.token).not.toBe("dead-owner");
    } finally {
      await release();
      await rm(path.join(repo, ".codex"), { recursive: true, force: true });
    }
  });
});
