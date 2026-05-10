import { mkdir, readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
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
import type { CodexaIndex, FileFact, FreshnessInfo, QueryResult, RepoSnapshotFact } from "../src/types.js";

describe("session memory storage", () => {
  it("records bounded entries with provenance, confidence, latest pointer, and summary buckets", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-"));
    const freshness = freshnessFixture("snap-1");

    const write = await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-1",
      taskId: "task-1",
      task: "implement feature",
      freshness,
      entries: [
        {
          kind: "claim",
          key: "claim:owner",
          summary: "src/session-memory.ts owns cache-only working memory.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived",
          scope: {
            files: ["src/session-memory.ts"],
            topics: ["session memory"]
          }
        }
      ]
    });

    expect(write.sessionId).toBe("sid-1");
    expect(write.writes).toMatchObject({ sessionId: "sid-1", taskId: "task-1", revision: 1 });
    expect(write.writes?.recordedEntryIds).toHaveLength(1);

    const latest = JSON.parse(await readFile(path.join(sessionMemoryCacheDir(repo), "latest.json"), "utf8")) as { sessionId: string; path: string; taskId: string };
    expect(latest).toMatchObject({ sessionId: "sid-1", path: "sessions/sid-1/memory.json", taskId: "task-1" });

    const read = await readSessionMemory({ repoRoot: repo, sessionId: "sid-1", taskId: "task-1", kinds: ["claim"], freshness });
    expect(read.memory.claims).toHaveLength(1);
    expect(read.memory.claims[0]).toMatchObject({
      type: "SessionMemoryEntry",
      source: "codex-agent",
      confidence: "heuristic",
      provenance: "agent-asserted",
      evidenceTier: "heuristic",
      status: "active"
    });
    expect(read.memory.claims[0].scope.files).toEqual(["src/session-memory.ts"]);
    expect(read.memory.claims[0].evidence[0]).toMatchObject({
      provenance: "agent-asserted",
      source: "agent",
      confidence: "heuristic",
      evidenceTier: "heuristic",
      snapshotId: "snap-1",
      headCommit: "abc"
    });

    const summary = await summarizeSessionMemory({ repoRoot: repo, sessionId: "sid-1", taskId: "task-1", freshness });
    expect(summary.memory.markdown).toContain("Claims:");
    expect(summary.memory.markdown).toContain("src/session-memory.ts owns cache-only working memory.");
  });

  it("replays append-only events when memory.json is corrupt", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-replay-"));
    const freshness = freshnessFixture("snap-1");
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-replay",
      freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:one-tool",
          summary: "Use one MCP tool with actions.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived"
        }
      ]
    });
    await writeFile(path.join(sessionMemoryCacheDir(repo), "sessions/sid-replay/memory.json"), "{bad json", "utf8");

    const replayed = await readSessionMemory({ repoRoot: repo, sessionId: "sid-replay", freshness });
    expect(replayed.warnings.some((warning) => warning.includes("session memory store invalid"))).toBe(true);
    expect(replayed.memory.decisions[0]?.summary).toBe("Use one MCP tool with actions.");
  });

  it("treats explicit codexa-derived remember input as agent-asserted working memory", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-provenance-"));
    const freshness = freshnessFixture("snap-1");

    const written = await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-provenance",
      freshness,
      entries: [
        {
          kind: "claim",
          key: "claim:forged",
          summary: "Forged Codexa provenance should be downgraded.",
          provenance: "codexa-derived",
          confidence: "authoritative",
          evidenceTier: "authoritative",
          evidence: [
            {
              id: "forged-evidence",
              provenance: "codexa-derived",
              source: "mcp_tool",
              sourceRef: "fake-tool:fake-call",
              evidenceTier: "authoritative",
              confidence: "authoritative",
              snapshotId: freshness.snapshotId,
              indexedAt: freshness.indexedAt,
              headCommit: freshness.headCommit
            }
          ]
        }
      ]
    });

    expect(written.memory.claims[0]).toMatchObject({ provenance: "agent-asserted", source: "codex-agent", confidence: "heuristic", evidenceTier: "heuristic" });
    expect(written.memory.claims[0].evidence[0]).toMatchObject({ provenance: "agent-asserted", source: "agent", confidence: "heuristic", evidenceTier: "heuristic" });
    expect(written.memory.claims[0].evidence.every((evidence) => evidence.snapshotId === freshness.snapshotId && evidence.indexedAt === freshness.indexedAt && evidence.headCommit === freshness.headCommit)).toBe(true);

    const summary = await summarizeSessionMemory({ repoRoot: repo, sessionId: "sid-provenance", freshness });
    expect(summary.memory.markdown).toContain("agent-asserted; heuristic/heuristic");

    const storePath = path.join(sessionMemoryCacheDir(repo), "sessions/sid-provenance/memory.json");
    const store = JSON.parse(await readFile(storePath, "utf8")) as { entries: Array<{ confidence: string; evidenceTier: string; evidence: Array<{ confidence: string; evidenceTier: string }> }> };
    store.entries[0].confidence = "authoritative";
    store.entries[0].evidenceTier = "authoritative";
    store.entries[0].evidence[0].confidence = "authoritative";
    store.entries[0].evidence[0].evidenceTier = "authoritative";
    await writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
    const sanitized = await readSessionMemory({ repoRoot: repo, sessionId: "sid-provenance", freshness });
    expect(sanitized.memory.claims[0]).toMatchObject({ confidence: "heuristic", evidenceTier: "heuristic" });
    expect(sanitized.memory.claims[0].evidence[0]).toMatchObject({ confidence: "heuristic", evidenceTier: "heuristic" });
  });

  it("replays events when memory.json has invalid entry shape", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-invalid-store-"));
    const freshness = freshnessFixture("snap-1");
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-invalid-store",
      freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:valid-event",
          summary: "Replay valid event after invalid store.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived"
        }
      ]
    });
    await writeFile(
      path.join(sessionMemoryCacheDir(repo), "sessions/sid-invalid-store/memory.json"),
      `${JSON.stringify({ schemaVersion: 1, sessionId: "sid-invalid-store", repoRoot: ".", revision: 1, entries: [{}] })}\n`,
      "utf8"
    );

    const replayed = await readSessionMemory({ repoRoot: repo, sessionId: "sid-invalid-store", freshness });
    expect(replayed.warnings).toContain("session memory store invalid: schema is invalid");
    expect(replayed.memory.decisions[0]?.summary).toBe("Replay valid event after invalid store.");
  });

  it("marks scoped entries stale without deleting them when freshness changes", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-stale-"));
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale",
      freshness: freshnessFixture("snap-1", { dirtyFiles: [] }),
      entries: [
        {
          kind: "viewed",
          key: "viewed:file",
          summary: "Viewed src/a.ts.",
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived",
          scope: {
            files: ["src/a.ts"]
          }
        }
      ]
    });

    const stale = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale",
      freshness: freshnessFixture("snap-2", { dirtyFiles: ["src/a.ts"], headCommit: "abc" })
    });
    expect(stale.memory.viewed[0]?.status).toBe("stale");
    expect(stale.memory.viewed[0]?.staleBecause.join(" ")).toContain("scope dirty");

    const activeOnly = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale",
      includeStale: false,
      freshness: freshnessFixture("snap-2", { dirtyFiles: ["src/a.ts"], headCommit: "abc" })
    });
    expect(activeOnly.memory.entries).toEqual([]);

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale",
      freshness: freshnessFixture("snap-3", { dirtyFiles: [], headCommit: "abc" }),
      entries: [
        {
          kind: "viewed",
          key: "viewed:file",
          summary: "Viewed src/a.ts again.",
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived",
          scope: {
            files: ["src/a.ts"]
          }
        }
      ]
    });
    const revalidated = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale",
      includeStale: false,
      freshness: freshnessFixture("snap-3", { dirtyFiles: [], headCommit: "abc" })
    });
    expect(revalidated.memory.viewed[0]?.status).toBe("active");
    expect(revalidated.memory.viewed[0]?.snapshotId).toBe("snap-3");
  });

  it("reactivates compacted stale entries when current freshness is clean", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-stale-compact-"));
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale-compact",
      freshness: freshnessFixture("snap-1", { dirtyFiles: [] }),
      entries: [
        {
          kind: "viewed",
          key: "viewed:compact-stale",
          summary: "Viewed src/compact-stale.ts.",
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived",
          scope: {
            files: ["src/compact-stale.ts"]
          }
        }
      ]
    });

    await compactSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale-compact",
      freshness: freshnessFixture("snap-2", { dirtyFiles: ["src/compact-stale.ts"], headCommit: "abc" })
    });

    const active = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-stale-compact",
      includeStale: false,
      freshness: freshnessFixture("snap-3", { dirtyFiles: [], headCommit: "abc" })
    });
    expect(active.memory.viewed[0]?.status).toBe("active");
    expect(active.memory.viewed[0]?.staleBecause).toEqual([]);
  });

  it("uses the active task id for later writes that omit taskId", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-active-task-"));
    const freshness = freshnessFixture("snap-1");
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-active-task",
      taskId: "task-active",
      freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:first",
          summary: "Initial task-scoped decision.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "heuristic"
        }
      ]
    });

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-active-task",
      freshness,
      entries: [
        {
          kind: "verification",
          key: "verification:implicit-task",
          summary: "Follow-up verification inherits the active task.",
          provenance: "codexa-derived",
          confidence: "derived",
          evidenceTier: "derived"
        }
      ]
    });

    const recalled = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-active-task",
      taskId: "task-active",
      kinds: ["verification"],
      freshness
    });
    expect(recalled.memory.verification[0]?.summary).toBe("Follow-up verification inherits the active task.");
    expect(recalled.memory.verification[0]?.taskId).toBe("task-active");
  });

  it("revalidates stale entries across head changes using newest evidence", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-head-revalidate-"));
    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-head",
      freshness: freshnessFixture("snap-1", { headCommit: "abc", indexedAt: "2026-05-05T00:00:00.000Z" }),
      entries: [
        {
          kind: "claim",
          key: "claim:head",
          summary: "Head-sensitive claim.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived",
          scope: { files: ["src/head.ts"] }
        }
      ]
    });

    const stale = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-head",
      freshness: freshnessFixture("snap-2", { headCommit: "def", indexedAt: "2026-05-05T00:01:00.000Z" })
    });
    expect(stale.memory.claims[0]?.status).toBe("stale");

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-head",
      freshness: freshnessFixture("snap-3", { headCommit: "def", indexedAt: "2026-05-05T00:02:00.000Z" }),
      entries: [
        {
          kind: "claim",
          key: "claim:head",
          summary: "Head-sensitive claim.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived",
          scope: { files: ["src/head.ts"] }
        }
      ]
    });

    const active = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-head",
      includeStale: false,
      freshness: freshnessFixture("snap-3", { headCommit: "def", indexedAt: "2026-05-05T00:02:00.000Z" })
    });
    expect(active.memory.claims[0]?.status).toBe("active");
    expect(active.memory.claims[0]?.snapshotId).toBe("snap-3");
  });

  it("keeps newest evidence for staleness after evidence compaction", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-evidence-cap-"));
    for (let index = 0; index < 30; index += 1) {
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "sid-evidence-cap",
        freshness: freshnessFixture(`snap-${index}`, {
          headCommit: "abc",
          indexedAt: `2026-05-05T00:${String(index).padStart(2, "0")}:00.000Z`
        }),
        entries: [
          {
            kind: "claim",
            key: "claim:evidence-cap",
            summary: "Evidence cap claim.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "derived",
            scope: { files: ["src/evidence.ts"] }
          }
        ]
      });
    }

    await recordSessionMemory({
      repoRoot: repo,
      sessionId: "sid-evidence-cap",
      freshness: freshnessFixture("snap-new-head", {
        headCommit: "def",
        indexedAt: "2026-05-05T01:00:00.000Z"
      }),
      entries: [
        {
          kind: "claim",
          key: "claim:evidence-cap",
          summary: "Evidence cap claim.",
          provenance: "agent-asserted",
          confidence: "heuristic",
          evidenceTier: "derived",
          scope: { files: ["src/evidence.ts"] }
        }
      ]
    });

    const active = await readSessionMemory({
      repoRoot: repo,
      sessionId: "sid-evidence-cap",
      includeStale: false,
      freshness: freshnessFixture("snap-new-head", {
        headCommit: "def",
        indexedAt: "2026-05-05T01:00:00.000Z"
      })
    });
    expect(active.memory.claims[0]?.status).toBe("active");
    expect(active.memory.claims[0]?.evidence.some((evidence) => evidence.headCommit === "def")).toBe(true);
  });

  it("auto-records change plans as viewed refs, next reads, decisions, and verification", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-plan-"));
    const freshness = freshnessFixture("snap-plan");
    const index = indexFixture(repo, freshness, [
      fileFixture("src/a.ts", freshness),
      fileFixture("tests/a.test.ts", freshness, { test: true })
    ]);

    const writes = await recordViewedMemoryForTool({
      repoRoot: repo,
      toolName: "change_plan",
      result: {
        freshness,
        text: "plan",
        data: {
          mode: "change_plan",
          task: "tighten session memory",
          plannedEditTargets: ["src/a.ts"],
          tests: [{ path: "tests/a.test.ts" }],
          requiredWorkflowChecks: [{ target: "workflow" }],
          requiredDependencyChecks: [{ target: "dependency" }],
          snapshot: { taskId: "task-plan" }
        }
      } satisfies QueryResult,
      index
    });

    expect(writes?.recordedEntryIds.length).toBeGreaterThanOrEqual(4);
    const memory = await readSessionMemory({ repoRoot: repo, taskId: "task-plan", freshness, limit: 20 });
    expect(memory.memory.viewed[0]?.summary).toContain("change_plan returned");
    expect(memory.memory.decisions[0]?.summary).toContain("change_plan prepared 1 planned edit target");
    expect(memory.memory.nextReads[0]?.summary).toContain("Read planned edit target(s): src/a.ts");
    expect(memory.memory.verification[0]?.summary).toContain("change_plan queued 1 test target");
  });

  it("does not auto-record nested test refs for orientation-only change plans", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-plan-orientation-"));
    const freshness = freshnessFixture("snap-plan-orientation");
    const index = indexFixture(repo, freshness, [
      fileFixture("src/a.ts", freshness),
      fileFixture("tests/a.test.ts", freshness, { test: true })
    ]);

    const writes = await recordViewedMemoryForTool({
      repoRoot: repo,
      toolName: "change_plan",
      result: {
        freshness,
        text: "orientation plan",
        data: {
          mode: "change_plan",
          task: "change behavior safely",
          editReadiness: { editable: false, status: "orientation-only" },
          snapshotBlock: { taskId: "generated-blocked-task", path: ".codex/cache/codexa-tasks/generated-blocked-task.blocked.json" },
          plannedEditTargets: [],
          tests: [],
          context: {
            focusFiles: [{ file: { path: "src/a.ts" } }],
            tests: [{ path: "tests/a.test.ts" }]
          }
        }
      } satisfies QueryResult,
      index
    });

    expect(writes?.recordedEntryIds.length).toBeGreaterThanOrEqual(2);
    expect(writes?.taskId).toBe("generated-blocked-task");
    const memory = await readSessionMemory({ repoRoot: repo, freshness, limit: 20 });
    expect(memory.memory.viewed[0]?.summary).toContain("change_plan returned");
    expect(memory.memory.viewed[0]?.summary).not.toContain("test");
    expect(memory.memory.viewed[0]?.scope.tests).toEqual([]);
    expect(memory.memory.decisions[0]?.summary).toContain("change_plan withheld planned edit targets");
    expect(memory.memory.decisions[0]?.scope.tests).toEqual([]);
    expect(memory.memory.nextReads).toEqual([]);
    expect(memory.memory.verification).toEqual([]);
  });

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
});

function indexFixture(repoRoot: string, freshness: FreshnessInfo, files: FileFact[]): CodexaIndex {
  const snapshot: RepoSnapshotFact = {
    id: "repo-snapshot",
    type: "RepoSnapshot",
    source: "git",
    confidence: "authoritative",
    snapshotId: freshness.snapshotId,
    indexedAt: freshness.indexedAt,
    repoRoot,
    gitRoot: repoRoot,
    headCommit: freshness.headCommit,
    dirtyFiles: freshness.dirtyFiles
  };
  return {
    schemaVersion: 1,
    snapshot,
    freshness,
    files,
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [],
    workflows: [],
    modules: [],
    risks: [],
    parserErrors: []
  };
}

function fileFixture(filePath: string, freshness: FreshnessInfo, overrides: Partial<FileFact> = {}): FileFact {
  return {
    id: `file:${filePath}`,
    type: "File",
    path: filePath,
    source: "tree-sitter",
    confidence: "authoritative",
    snapshotId: freshness.snapshotId,
    indexedAt: freshness.indexedAt,
    language: filePath.endsWith(".ts") ? "typescript" : "unknown",
    sizeBytes: 10,
    dirty: false,
    generated: false,
    test: false,
    rank: 1,
    rankReasons: {},
    symbolCount: 0,
    usageCount: 0,
    importCount: 0,
    riskScore: 0,
    ...overrides
  };
}

function freshnessFixture(snapshotId: string, overrides: Partial<FreshnessInfo> = {}): FreshnessInfo {
  const dirtyFiles = overrides.dirtyFiles ?? [];
  return {
    schemaVersion: 1,
    snapshotId,
    repoRoot: "/tmp/repo",
    gitRoot: "/tmp/repo",
    headCommit: overrides.headCommit ?? "abc",
    indexedAt: overrides.indexedAt ?? "2026-05-05T00:00:00.000Z",
    dirtyFiles,
    dirtyFileHashes: Object.fromEntries(dirtyFiles.map((file) => [file, `${file}-hash`])),
    indexedDirtyFileHashes: {},
    indexedDirtyFiles: [],
    missing: false,
    stale: false,
    reason: "fresh",
    parserErrorCount: 0
  };
}
