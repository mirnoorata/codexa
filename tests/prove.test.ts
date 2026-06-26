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
      await expect(initializePolicyPack(repo)).rejects.toThrow(/not a regular file/u);
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
        files: ["src/widget.ts"],
        autoRefresh: false
      });
      const data = result.data as ProveData;

      expect(result.text).toContain("Codexa proof card");
      expect(result.text).toContain("Snapshot: loaded prove-test");
      expect(result.text).toContain("Local policies:");
      expect(data.actionability).toBe("verify");
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

  it("preserves test-plan needs_target actionability when no proof scope exists", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });

      const unscoped = await proveQuery(repo, {
        task: "prove clean repo",
        diff: false,
        autoRefresh: false
      });
      const unscopedData = unscoped.data as ProveData;
      expect(unscopedData.actionability).toBe("needs_target");
      expect(unscopedData.verification.tests).toEqual([]);
      expect(unscopedData.verification.recommendedCommands).toEqual([]);
      expect(unscopedData.gaps).toContain("test plan needs target files or a dirty diff");

      const scoped = await proveQuery(repo, {
        task: "prove clean repo",
        diff: false,
        files: ["src/widget.ts"],
        autoRefresh: false
      });
      const scopedData = scoped.data as ProveData;
      expect(scopedData.actionability).toBe("verify");
      expect(scopedData.verification.tests.some((test) => test.path === "tests/widget.test.ts")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("classifies reported verification evidence without treating preview as proof", async () => {
    const repo = await createProofFixtureRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-prove-outside-"));
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const result = await proveQuery(repo, {
        task: "change widget behavior",
        changeType: "behavior",
        autoRefresh: false,
        ranCommandReports: [
          {
            command: "npm test",
            cwd: repo,
            packageManager: "npm",
            packageRoot: ".",
            scriptName: "test",
            args: [],
            exitCode: 0,
            durationMs: 12,
            stdoutSummary: `vitest passed outside ${outside}`
          }
        ]
      });
      const data = result.data as ProveData;
      const serializedReported = JSON.stringify(data.verification.reported);

      expect(result.text).toContain("Verification preview (not proof until reported):");
      expect(result.text).toContain("Reported verification ledger:");
      expect(data.verification.reported.hasEvidence).toBe(true);
      expect(data.verification.ledgerPreview.some((entry) => entry.status === "would_cover")).toBe(true);
      expect(data.verification.reported.ledger.some((entry) => entry.target === "tests/widget.test.ts" && entry.status === "covered")).toBe(true);
      expect(data.verification.reported.testsNotRun.map((test) => test.path)).not.toContain("tests/widget.test.ts");
      expect(data.verification.reported.commandEnvelopes[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", scriptName: "test" });
      expect(serializedReported).not.toContain(outside);
      expect(serializedReported).toContain("<abs-path>");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not credit failed reports and records explicit waivers as waivers", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const failed = await proveQuery(repo, {
        task: "change widget behavior",
        changeType: "behavior",
        autoRefresh: false,
        ranCommandReports: [{ command: "npm test", cwd: repo, exitCode: 1, stderrSummary: "test failed" }]
      });
      const failedData = failed.data as ProveData;
      expect(failedData.verification.reported.ledger.some((entry) => entry.target === "tests/widget.test.ts" && entry.status === "covered")).toBe(false);
      expect(failedData.verification.reported.testsNotRun.map((test) => test.path)).toContain("tests/widget.test.ts");
      expect(failedData.gaps).toContain("reported verification missing: tests/widget.test.ts");

      const waived = await proveQuery(repo, {
        task: "change widget behavior",
        changeType: "behavior",
        autoRefresh: false,
        waivers: [{ kind: "test", target: "tests/widget.test.ts", reason: "manual browser regression" }]
      });
      const waivedData = waived.data as ProveData;
      expect(waivedData.verification.reported.ledger.some((entry) => entry.target === "tests/widget.test.ts" && entry.status === "waived")).toBe(true);
      expect(waivedData.verification.reported.waivedVerification.some((entry) => entry.target === "tests/widget.test.ts" && entry.waiverReason === "manual browser regression")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("includes missing snapshot-required workflow checks in the proof ledger", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-required-check",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/prove-required-check.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
        requiredWorkflowChecks?: unknown[];
      };
      snapshot.requiredWorkflowChecks = [
        {
          kind: "workflow",
          target: "release-gate",
          reason: "Release gate must be checked before final handoff",
          evidenceTier: "derived",
          confidence: "derived",
          paths: ["src/widget.ts"]
        }
      ];
      await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

      const result = await proveQuery(repo, {
        task: "change widget behavior",
        taskId: "prove-required-check",
        changeType: "behavior",
        autoRefresh: false
      });
      const data = result.data as ProveData;

      expect(data.verification.reported.ledger).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "workflow", target: "release-gate", status: "missing" })])
      );
      expect(data.gaps).toContain("reported verification missing: workflow release-gate");
      expect(result.text).toContain("missing: workflow release-gate");
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
