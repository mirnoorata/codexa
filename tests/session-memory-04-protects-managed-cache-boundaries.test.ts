import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compactSessionMemory, readSessionMemory, recordSessionMemory, sessionMemoryCacheDir } from "../src/session-memory.js";
import { freshnessFixture } from "./session-memory-fixtures.js";

const SESSION_ID = "sid-managed-boundary";
const VICTIM_BYTES = "victim bytes must remain unchanged\n";

describe("session memory managed-cache boundaries", () => {
  it.each([
    [".codex directory", ".codex"],
    ["cache directory", ".codex/cache"],
    ["memory root", ".codex/cache/codexa-session-memory"],
    ["sessions directory", ".codex/cache/codexa-session-memory/sessions"],
    ["session directory", `.codex/cache/codexa-session-memory/sessions/${SESSION_ID}`]
  ] as const)("rejects a redirected %s without writing through it", async (_label, relativeDirectory) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-dir-boundary-"));
    const victimRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-dir-victim-"));
    const victim = path.join(victimRoot, "victim.txt");
    const redirectedDirectory = path.join(repo, relativeDirectory);

    try {
      await writeFile(victim, VICTIM_BYTES, "utf8");
      await mkdir(path.dirname(redirectedDirectory), { recursive: true });
      await symlink(victimRoot, redirectedDirectory, "dir");

      await expect(recordOne(repo)).rejects.toThrow(/redirected|managed state|symbolic link/iu);
      expect(await readFile(victim, "utf8")).toBe(VICTIM_BYTES);
      expect((await readdir(victimRoot)).sort()).toEqual(["victim.txt"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(victimRoot, { recursive: true, force: true });
    }
  });

  it("rejects a redirected compaction directory without publishing outside managed state", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-compaction-boundary-"));
    const victimRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-compaction-victim-"));
    const victim = path.join(victimRoot, "victim.txt");

    try {
      await recordOne(repo);
      await writeFile(victim, VICTIM_BYTES, "utf8");
      const compactions = path.join(sessionMemoryCacheDir(repo), "sessions", SESSION_ID, "compactions");
      await symlink(victimRoot, compactions, "dir");

      await expect(
        compactSessionMemory({ repoRoot: repo, sessionId: SESSION_ID, freshness: freshnessFixture("snap-managed-boundary") })
      ).rejects.toThrow(/redirected|managed state|symbolic link/iu);
      expect(await readFile(victim, "utf8")).toBe(VICTIM_BYTES);
      expect((await readdir(victimRoot)).sort()).toEqual(["victim.txt"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(victimRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when an implicit lookup resolves to an existing redirected session", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-existing-implicit-boundary-"));
    const victimRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-existing-implicit-victim-"));
    const cacheDir = sessionMemoryCacheDir(repo);
    const sessionsDir = path.join(cacheDir, "sessions");
    const latestPath = path.join(cacheDir, "latest.json");
    const latest = `${JSON.stringify({
      schemaVersion: 1,
      sessionId: SESSION_ID,
      path: `sessions/${SESSION_ID}/memory.json`,
      updatedAt: "2026-01-01T00:00:00.000Z"
    }, null, 2)}\n`;

    try {
      await mkdir(sessionsDir, { recursive: true });
      await symlink(victimRoot, path.join(sessionsDir, SESSION_ID), "dir");
      await writeFile(latestPath, latest, "utf8");

      await expect(
        recordSessionMemory({
          repoRoot: repo,
          freshness: freshnessFixture("snap-existing-implicit-boundary"),
          entries: [
            {
              kind: "decision",
              key: "decision:existing-implicit-boundary",
              summary: "Do not reset an existing implicit session after a managed-path failure.",
              provenance: "agent-asserted",
              confidence: "heuristic",
              evidenceTier: "heuristic"
            }
          ]
        })
      ).rejects.toThrow(/redirected|managed state|symbolic link/iu);
      expect(await readFile(latestPath, "utf8")).toBe(latest);
      expect(await readdir(victimRoot)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(victimRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["symlink", "events.ndjson"],
    ["hardlink", "events.ndjson"],
    ["symlink", "memory.json"],
    ["hardlink", "memory.json"],
    ["symlink", "latest.json"],
    ["hardlink", "latest.json"]
  ] as const)("rejects a %s-managed %s target without changing victim bytes", async (kind, fileName) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-file-boundary-"));
    const victim = path.join(repo, `victim-${kind}-${fileName}`);
    const cacheDir = sessionMemoryCacheDir(repo);
    const sessionDirectory = path.join(cacheDir, "sessions", SESSION_ID);
    const target = fileName === "latest.json" ? path.join(cacheDir, fileName) : path.join(sessionDirectory, fileName);

    try {
      await writeFile(victim, VICTIM_BYTES, "utf8");
      await mkdir(path.dirname(target), { recursive: true });
      if (kind === "symlink") {
        await symlink(victim, target);
      } else {
        await link(victim, target);
      }

      await expect(recordOne(repo)).rejects.toThrow(/redirected|managed file|symbolic link|too many levels/iu);
      expect(await readFile(victim, "utf8")).toBe(VICTIM_BYTES);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it.each(["symlink", "hardlink"] as const)(
    "rejects a %s compaction archive target and leaves its victim unchanged",
    async (kind) => {
      const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-archive-boundary-"));
      const victim = path.join(repo, `victim-${kind}-archive.json`);

      try {
        await recordOne(repo);
        await writeFile(victim, VICTIM_BYTES, "utf8");
        const compactions = path.join(sessionMemoryCacheDir(repo), "sessions", SESSION_ID, "compactions");
        await mkdir(compactions);
        const target = path.join(compactions, "2.json");
        if (kind === "symlink") {
          await symlink(victim, target);
        } else {
          await link(victim, target);
        }

        await expect(
          compactSessionMemory({ repoRoot: repo, sessionId: SESSION_ID, freshness: freshnessFixture("snap-managed-boundary") })
        ).rejects.toThrow(/redirected|managed file|symbolic link/iu);
        expect(await readFile(victim, "utf8")).toBe(VICTIM_BYTES);
        expect((await readdir(compactions)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    }
  );

  it("maps non-portable logical session ids to distinct portable directory names", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-portable-id-"));
    try {
      const paths = new Map<string, string>();
      const reservedLookalike = "__codexa_session_v1_team-deadbeef";
      for (const sessionId of ["team:1", "team-1", "Team", "team", "CON", "nul.txt", "trailing.", reservedLookalike]) {
        const result = await recordSessionMemory({
          repoRoot: repo,
          sessionId,
          freshness: freshnessFixture(`snap-${sessionId}`),
          entries: [
            {
              kind: "decision",
              key: `decision:${sessionId}`,
              summary: `Portable session path for ${sessionId}.`,
              provenance: "agent-asserted",
              confidence: "heuristic",
              evidenceTier: "heuristic"
            }
          ]
        });
        expect(result.sessionId).toBe(sessionId);
        const relativePath = result.writes?.path ?? "";
        const directoryName = relativePath.split("/")[1] ?? "";
        expect(directoryName).toMatch(/^[A-Za-z0-9._-]+$/u);
        expect(directoryName).toBe(directoryName.toLowerCase());
        expect(directoryName).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
        expect(directoryName).not.toMatch(/[. ]$/u);
        expect(JSON.parse(await readFile(path.join(sessionMemoryCacheDir(repo), relativePath), "utf8"))).toMatchObject({
          sessionId
        });
        paths.set(sessionId, relativePath);
      }
      expect(paths.get("team:1")).not.toBe(paths.get("team-1"));
      expect(paths.get("Team")).not.toBe(paths.get("team"));
      expect(paths.get(reservedLookalike)).not.toBe(`sessions/${reservedLookalike}/memory.json`);
      expect(new Set([...paths.values()].map((value) => value.toLowerCase())).size).toBe(paths.size);
      const compacted = await compactSessionMemory({
        repoRoot: repo,
        sessionId: "team:1",
        freshness: freshnessFixture("snap-team-compact")
      });
      const mappedSessionDirectory = path.dirname(paths.get("team:1") ?? "");
      expect(
        JSON.parse(
          await readFile(
            path.join(
              sessionMemoryCacheDir(repo),
              mappedSessionDirectory,
              "compactions",
              `${compacted.revision}.json`
            ),
            "utf8"
          )
        )
      ).toMatchObject({ sessionId: "team:1", toRevision: compacted.revision });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reads and atomically migrates exact-id legacy session directories", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-legacy-migration-"));
    const sessionId = "Team:Legacy";
    try {
      const first = await recordSessionMemory({
        repoRoot: repo,
        sessionId,
        freshness: freshnessFixture("snap-legacy-first"),
        entries: [
          {
            kind: "decision",
            key: "decision:legacy-first",
            summary: "Preserve legacy session evidence during migration.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      const mappedDirectory = path.join(sessionMemoryCacheDir(repo), path.dirname(first.writes?.path ?? ""));
      const rawLegacyDirectory = path.join(sessionMemoryCacheDir(repo), "sessions", sessionId);
      await rename(mappedDirectory, rawLegacyDirectory);

      const loaded = await readSessionMemory({
        repoRoot: repo,
        sessionId,
        freshness: freshnessFixture("snap-legacy-read")
      });
      expect(loaded.revision).toBe(first.revision);
      expect(loaded.memory.decisions.map((entry) => entry.key)).toContain("decision:legacy-first");

      const second = await recordSessionMemory({
        repoRoot: repo,
        sessionId,
        freshness: freshnessFixture("snap-legacy-second"),
        entries: [
          {
            kind: "decision",
            key: "decision:legacy-second",
            summary: "Continue writing after legacy migration.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      expect(second.revision).toBe(first.revision + 1);
      expect(await readdir(path.join(sessionMemoryCacheDir(repo), "sessions"))).not.toContain(sessionId);
      expect(JSON.parse(await readFile(path.join(sessionMemoryCacheDir(repo), second.writes?.path ?? ""), "utf8"))).toMatchObject({
        sessionId,
        revision: second.revision
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on a case-folding collision with a legacy session directory", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-memory-casefold-collision-"));
    try {
      const legacy = await recordSessionMemory({
        repoRoot: repo,
        sessionId: "Team",
        freshness: freshnessFixture("snap-casefold-legacy"),
        entries: [
          {
            kind: "decision",
            key: "decision:casefold-owner",
            summary: "Keep the exact logical session owner.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      const mappedDirectory = path.join(sessionMemoryCacheDir(repo), path.dirname(legacy.writes?.path ?? ""));
      const rawLegacyDirectory = path.join(sessionMemoryCacheDir(repo), "sessions", "Team");
      await rename(mappedDirectory, rawLegacyDirectory);
      const before = await readFile(path.join(rawLegacyDirectory, "memory.json"), "utf8");

      await expect(
        recordSessionMemory({
          repoRoot: repo,
          sessionId: "team",
          freshness: freshnessFixture("snap-casefold-conflict"),
          entries: [
            {
              kind: "decision",
              key: "decision:casefold-intruder",
              summary: "Must not enter another session's directory.",
              provenance: "agent-asserted",
              confidence: "heuristic",
              evidenceTier: "heuristic"
            }
          ]
        })
      ).rejects.toThrow(/case-folding session directory collision/iu);
      expect(await readFile(path.join(rawLegacyDirectory, "memory.json"), "utf8")).toBe(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function recordOne(repoRoot: string) {
  return recordSessionMemory({
    repoRoot,
    sessionId: SESSION_ID,
    freshness: freshnessFixture("snap-managed-boundary"),
    entries: [
      {
        kind: "decision",
        key: "decision:managed-boundary",
        summary: "Keep session-memory state inside its managed cache boundary.",
        provenance: "agent-asserted",
        confidence: "heuristic",
        evidenceTier: "heuristic"
      }
    ]
  });
}
