import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery } from "../src/queries.js";
import type { ChangeEvidenceBundleV1 } from "../src/types.js";

describe("orientation-only causal guidance", () => {
  it("routes a no-chain plan to its recommended next tool without inventing an explicit target", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-orientation-evidence-"));
    try {
      git(repo, "init");
      git(repo, "config", "user.email", "tests@codexa.local");
      git(repo, "config", "user.name", "Codexa Tests");
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
      await writeFile(path.join(repo, "src/isolated.ts"), "export const isolated = 1\n", "utf8");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "test: create orientation fixture");
      await buildIndex({ repoRoot: repo });

      const result = await changePlanQuery(
        repo,
        { task: "Improve the product", diff: false, saveSnapshot: false },
        { autoRefresh: false }
      );
      const data = result.data as {
        editReadiness: { editable: boolean; recommendedNextTool?: string };
        evidenceChains: ChangeEvidenceBundleV1;
      };

      expect(data.editReadiness.editable).toBe(false);
      expect(data.evidenceChains.chains).toEqual([]);
      expect(data.editReadiness.recommendedNextTool).toBeTruthy();
      expect(result.text).toContain(`No bounded causal chain was proven; use ${data.editReadiness.recommendedNextTool} next`);
      expect(result.text).not.toContain("No bounded causal chain was proven; inspect the explicit target");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
