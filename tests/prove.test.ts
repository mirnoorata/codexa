import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndexLocked } from "../src/indexer.js";
import { initializePolicyPack, loadPolicyPack } from "../src/policy-pack.js";
import { proveQuery, type ProveData } from "../src/prove.js";
import { changePlanQuery } from "../src/queries.js";

describe("Codexa proof cards", () => {
  it("writes and reads the local policy pack without overwriting by default", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-policy-pack-"));
    try {
      const first = await initializePolicyPack(repo);
      expect(first.written).toEqual([
        ".codex/policies/verification.json",
        ".codex/policies/complexity.json",
        ".codex/policies/security.json"
      ]);
      const verificationPath = path.join(repo, ".codex/policies/verification.json");
      const original = await readFile(verificationPath, "utf8");
      await writeFile(verificationPath, original.replace("Require evidence-backed verification", "Require project-specific verification"), "utf8");

      const second = await initializePolicyPack(repo);
      expect(second.written).toEqual([]);
      expect(second.skipped).toContain(".codex/policies/verification.json");

      const policyPack = await loadPolicyPack(repo);
      expect(policyPack.policies).toHaveLength(3);
      expect(policyPack.policies.find((policy) => policy.kind === "verification")?.purpose).toContain("project-specific");
      expect(policyPack.warnings).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses missing roots and ignores symlinked policy files", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-policy-boundary-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-policy-outside-"));
    try {
      await expect(initializePolicyPack(path.join(repo, "missing"))).rejects.toThrow(/existing repository directory/u);
      await initializePolicyPack(repo);
      await rm(path.join(repo, ".codex/policies/security.json"));
      await writeFile(
        path.join(outside, "security.json"),
        JSON.stringify({ schemaVersion: 1, kind: "security", purpose: "outside", rules: ["outside"] }),
        "utf8"
      );
      await symlink(path.join(outside, "security.json"), path.join(repo, ".codex/policies/security.json"));

      const policyPack = await loadPolicyPack(repo);
      expect(policyPack.policies.map((policy) => policy.kind)).not.toContain("security");
      expect(policyPack.warnings.join("\n")).toContain("security.json is a symlink; ignored");
      await expect(initializePolicyPack(repo, { force: true })).rejects.toThrow(/not a regular file/u);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports freshness, a saved plan snapshot, verification preview, and local policies", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await initializePolicyPack(repo);
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-test",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );

      const result = await proveQuery(repo, {
        task: "change widget behavior",
        taskId: "prove-test",
        changeType: "behavior",
        autoRefresh: false
      });
      const data = result.data as ProveData;

      expect(result.text).toContain("Codexa proof card");
      expect(result.text).toContain("Snapshot: loaded prove-test");
      expect(result.text).toContain("Local policies:");
      expect(data.freshness.stale).toBe(false);
      expect(data.snapshot.status).toBe("loaded");
      expect(data.snapshot.plannedEditTargets).toContain("src/widget.ts");
      expect(data.policies.policies.map((policy) => policy.kind).sort()).toEqual(["complexity", "security", "verification"]);
      expect(data.nextCommands.some((command) => command.includes("post-edit-review"))).toBe(true);
      expect(data.verification.tests.some((test) => test.path === "tests/widget.test.ts")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

async function createProofFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-prove-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: "codexa-prove-fixture",
        scripts: {
          test: "vitest run tests/widget.test.ts",
          typecheck: "tsc -p tsconfig.json --noEmit"
        },
        dependencies: {}
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "src/widget.ts"), "export function widget() { return 'ready' }\n", "utf8");
  await writeFile(path.join(repo, "tests/widget.test.ts"), "import { widget } from '../src/widget'\nexport const result = widget()\n", "utf8");
  return repo;
}
