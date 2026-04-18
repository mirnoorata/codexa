import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, getFreshness } from "../src/indexer.js";
import { liveIndexSignature, runLiveIndexer } from "../src/live-index.js";

describe("Codexa live indexing", () => {
  it("debounces source changes and refreshes generated artifacts through the normal locked index path", async () => {
    const repo = await createLiveFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const before = await liveIndexSignature(repo);
    const controller = new AbortController();
    const events: string[] = [];
    const live = runLiveIndexer(repo, {
      debounceMs: 75,
      pollMs: 250,
      initial: false,
      maxRuns: 1,
      persistent: false,
      signal: controller.signal,
      onEvent: (event) => events.push(event.type)
    });

    try {
      await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 2 }\n", "utf8");
      const summary = await withTimeout(live, 10_000);
      expect(summary.runs).toHaveLength(1);
      expect(summary.runs[0].files).toBeGreaterThan(0);
      expect(events).toContain("change-detected");
      expect(events).toContain("index-start");
      expect(events).toContain("index-complete");

      const freshness = await getFreshness(repo);
      expect(freshness.stale).toBe(false);
      expect(freshness.reason).toBe("fresh-with-dirty-overlay");
      expect(freshness.dirtyFiles).toEqual(["src/util.ts"]);
      expect((await liveIndexSignature(repo)).signature).not.toBe(before.signature);
      expect(await readFile(path.join(repo, ".codex/codebase/index.json"), "utf8")).toContain("helper");
    } finally {
      controller.abort();
      await live.catch(() => undefined);
    }
  });

  it("treats .codex/static-analysis reports as index inputs instead of generated artifacts", async () => {
    const repo = await createLiveFixtureRepo();
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, ".codex/static-analysis/.watch-placeholder"), "watch me\n", "utf8");
    await buildIndex({ repoRoot: repo });
    const before = await liveIndexSignature(repo);
    const controller = new AbortController();
    const events: string[] = [];
    const live = runLiveIndexer(repo, {
      debounceMs: 75,
      pollMs: 5_000,
      initial: false,
      maxRuns: 1,
      persistent: false,
      signal: controller.signal,
      onEvent: (event) => events.push(event.type)
    });

    try {
      await writeFile(
        path.join(repo, ".codex/static-analysis/semgrep.json"),
        JSON.stringify(
          {
            results: [
              {
                check_id: "semgrep.live-risk",
                path: "src/util.ts",
                start: { line: 1 },
                extra: { severity: "WARNING", message: "live static analysis risk" }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );
      const summary = await withTimeout(live, 10_000);
      expect(summary.runs).toHaveLength(1);
      expect(events).toContain("change-detected");
      expect(events).toContain("index-complete");

      const freshness = await getFreshness(repo);
      expect(freshness.stale).toBe(false);
      expect(freshness.dirtyFiles).toContain(".codex/static-analysis/semgrep.json");
      expect((await liveIndexSignature(repo)).signature).not.toBe(before.signature);
      expect(await readFile(path.join(repo, ".codex/codebase/index.json"), "utf8")).toContain("semgrep.live-risk");
    } finally {
      controller.abort();
      await live.catch(() => undefined);
    }
  });

  it("coalesces burst source edits and ignores generated artifact churn", async () => {
    const repo = await createLiveFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const controller = new AbortController();
    const events: string[] = [];
    const live = runLiveIndexer(repo, {
      debounceMs: 100,
      pollMs: 5_000,
      initial: false,
      maxRuns: 1,
      persistent: false,
      signal: controller.signal,
      onEvent: (event) => events.push(event.type === "change-detected" ? `${event.type}:${event.reason}` : event.type)
    });

    try {
      await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 3 }\n", "utf8");
      await writeFile(path.join(repo, "src/extra.ts"), "export const extra = 1\n", "utf8");
      await writeFile(path.join(repo, ".codex/codebase/generated-noise.md"), "# generated noise\n", "utf8");
      const summary = await withTimeout(live, 10_000);
      expect(summary.runs).toHaveLength(1);
      expect(events.some((event) => event.startsWith("change-detected:"))).toBe(true);

      const freshness = await getFreshness(repo);
      expect(freshness.dirtyFiles).toContain("src/util.ts");
      expect(freshness.dirtyFiles).toContain("src/extra.ts");
      expect(freshness.dirtyFiles).not.toContain(".codex/codebase/generated-noise.md");
    } finally {
      controller.abort();
      await live.catch(() => undefined);
    }
  });

  it("uses the poll fallback for delete and recreate changes when fs watching is unavailable", async () => {
    const repo = await createLiveFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const controller = new AbortController();
    const events: string[] = [];
    const live = runLiveIndexer(repo, {
      debounceMs: 50,
      pollMs: 100,
      initial: false,
      maxRuns: 1,
      persistent: false,
      watchFs: false,
      signal: controller.signal,
      onEvent: (event) => events.push(event.type === "change-detected" ? `${event.type}:${event.reason}` : event.type)
    });

    try {
      await rm(path.join(repo, "src/util.ts"));
      await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 4 }\n", "utf8");
      const summary = await withTimeout(live, 10_000);
      expect(summary.runs).toHaveLength(1);
      expect(events).toContain("change-detected:poll");
      const freshness = await getFreshness(repo);
      expect(freshness.reason).toBe("fresh-with-dirty-overlay");
      expect(freshness.dirtyFiles).toEqual(["src/util.ts"]);
    } finally {
      controller.abort();
      await live.catch(() => undefined);
    }
  });
});

async function createLiveFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-live-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 1 }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
