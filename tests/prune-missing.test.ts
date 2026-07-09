import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneMissingFiles, prunedFilesGap } from "../src/query/prune-missing.js";

describe("pruneMissingFiles", () => {
  it("drops entries whose file no longer exists and counts them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-prune-"));
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/live.ts"), "export const live = 1\n", "utf8");

    const result = pruneMissingFiles(
      [{ path: "src/live.ts" }, { path: "src/ghost.ts" }, { path: "also/gone.ts" }],
      repo,
      (entry) => entry.path
    );

    expect(result.entries).toEqual([{ path: "src/live.ts" }]);
    expect(result.prunedCount).toBe(2);
    expect(prunedFilesGap(result.prunedCount)).toContain("2 indexed file(s) no longer exist");
  });

  it("keeps everything and reports zero pruned when all files exist", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-prune-clean-"));
    await writeFile(path.join(repo, "a.ts"), "export const a = 1\n", "utf8");
    const result = pruneMissingFiles([{ path: "a.ts" }], repo, (entry) => entry.path);
    expect(result.entries).toHaveLength(1);
    expect(result.prunedCount).toBe(0);
  });
});
