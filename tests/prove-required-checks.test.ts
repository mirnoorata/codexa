import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
import { proveQuery, type ProveData } from "../src/prove.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";

describe("proof required-check reconstruction", () => {
  it("keeps typed dependency checks covered after a successful post-edit review", async () => {
    const repo = await createDependencyFixture();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const plan = await changePlanQuery(repo, {
        task: "change the cart summary label",
        files: ["src/summary.ts"],
        taskId: "proof-required-checks",
        changeType: "behavior",
        saveSnapshot: true
      }, { autoRefresh: false });
      expect((plan.data as { snapshot: { requiredDependencyChecks: unknown[] } }).snapshot.requiredDependencyChecks.length).toBeGreaterThan(0);

      await writeFile(
        path.join(repo, "src/summary.ts"),
        "import { total } from './cart'\nexport const summary = (items: number[]) => `Cart total: ${total(items)}`\n",
        "utf8"
      );
      const command = "vitest run tests/summary.test.ts";
      const review = await postEditReviewQuery(repo, {
        taskId: "proof-required-checks",
        ranCommands: [command],
        persistOutcome: true
      }, { autoRefresh: true });
      expect((review.data as { verdict: string }).verdict).toBe("continue");

      const proof = await proveQuery(repo, {
        taskId: "proof-required-checks",
        ranCommands: [command],
        autoRefresh: false
      });
      const data = proof.data as ProveData;
      expect(data.verification.reported.ledger.filter((entry) => entry.kind === "dependency" && entry.status === "missing")).toEqual([]);
      expect(data.gaps.filter((gap) => gap.startsWith("reported verification missing: dependency"))).toEqual([]);

      const proofFromResolvedReview = await proveQuery(repo, {
        taskId: "proof-required-checks",
        autoRefresh: false
      });
      const resolvedData = proofFromResolvedReview.data as ProveData;
      expect(resolvedData.verification.reported.ledger.filter((entry) => entry.kind === "dependency" && entry.status === "missing")).toEqual([]);
      expect(resolvedData.gaps.filter((gap) => gap.startsWith("reported verification missing: dependency"))).toEqual([]);
      expect(resolvedData.gaps).toContain("resolved lifecycle history is not explicit verification evidence in the current proof packet");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function createDependencyFixture(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-proof-required-checks-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({
    name: "proof-required-checks",
    private: true,
    scripts: { test: "vitest run tests/summary.test.ts" }
  }), "utf8");
  await writeFile(path.join(repo, "src/cart.ts"), "export const total = (items: number[]) => items.reduce((sum, item) => sum + item, 0)\n", "utf8");
  await writeFile(path.join(repo, "src/summary.ts"), "import { total } from './cart'\nexport const summary = (items: number[]) => `Total: ${total(items)}`\n", "utf8");
  await writeFile(path.join(repo, "tests/summary.test.ts"), "import { summary } from '../src/summary'\nexport const result = summary([1, 2])\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
}
