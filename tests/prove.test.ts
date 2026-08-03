import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndexLocked } from "../src/indexer.js";
import { initializePolicyPack, loadPolicyPack } from "../src/policy-pack.js";
import { proveQuery, type ProveData } from "../src/prove.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { compactSessionMemory, recordSessionMemory } from "../src/session-memory.js";
import { ingestVerificationArtifact, workspaceStateDigest } from "../src/verification-artifacts.js";

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
        autoRefresh: false
      });
      const data = result.data as ProveData;

      expect(result.text).toContain("Codexa proof card");
      expect(result.text).toContain("Snapshot: loaded prove-test");
      expect(result.text).toContain("Actionability: verify");
      expect(result.text).toContain("Status: action required");
      expect(result.text).toContain(`Proof gaps: ${data.gaps.length}`);
      expect(result.text).toContain("Local policies:");
      expect(data.actionability).toBe("verify");
      expect(data.freshness.stale).toBe(false);
      expect(data.snapshot.status).toBe("loaded");
      expect(data.snapshot.plannedEditTargets).toContain("src/widget.ts");
      expect(data.policies.policies.map((policy) => policy.kind).sort()).toEqual(["complexity", "security", "verification"]);
      expect(data.nextCommands.some((command) => command.includes("post-edit-review"))).toBe(true);
      expect(data.nextCommands.every((command) => !command.includes("codexa prove") && !command.includes("codexa test-plan"))).toBe(true);
      const postEditCommand = data.nextCommands.find((command) => command.includes("post-edit-review"));
      expect(postEditCommand).toContain("--task-id 'prove-test'");
      expect(postEditCommand).toContain("--ran-command '<command-you-ran>'");
      expect(postEditCommand).not.toContain("--ran-command 'npm test");
      expect(data.verification.tests.some((test) => test.path === "tests/widget.test.ts")).toBe(true);
      expect(data.verification.commandPlan.every((entry) => entry.trustTier === "none")).toBe(true);
      expect(data.verification.ledgerPreview.every((entry) => entry.trustTier === "none")).toBe(true);
      expect(data.trustPosture.join("\n")).toContain("executed-by-autoverify > witnessed > artifact-corroborated > reported > none");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("surfaces invariant reviews and a latched lifecycle stop as proof gaps", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const plan = await changePlanQuery(repo, {
        task: "Keep widget logic general",
        files: ["src/widget.ts"],
        taskId: "prove-lifecycle",
        invariants: ["No fixture-specific behavior."],
        saveSnapshot: true
      }, { autoRefresh: false });
      const invariant = ((plan.data as { snapshot: { invariants: Array<{ id: string }> } }).snapshot.invariants)[0]!;
      await postEditReviewQuery(repo, {
        taskId: "prove-lifecycle",
        invariantReviews: [{ invariantId: invariant.id, status: "violated", evidence: ["Fixture-specific branch remains"] }],
        persistOutcome: true
      }, { autoRefresh: true });

      const result = await proveQuery(repo, { taskId: "prove-lifecycle", autoRefresh: false });
      const data = result.data as ProveData;
      expect(data.lifecycle).toMatchObject({ status: "loaded", pendingStop: { planRevision: 1 } });
      expect(data.lifecycle.invariantReviews).toEqual(expect.arrayContaining([expect.objectContaining({ invariantId: invariant.id, status: "violated" })]));
      expect(data.gaps).toContain(`task invariant violated: ${invariant.id}`);
      expect(data.gaps.some((gap) => gap.startsWith("task lifecycle requires replan:"))).toBe(true);
      expect(data.nextCommands).toHaveLength(1);
      expect(data.nextCommands[0]).toContain("codexa change-plan");
      expect(data.nextCommands[0]).toContain("--task-id 'prove-lifecycle'");
      expect(data.nextCommands[0]).not.toContain("post-edit-review");
      expect(result.text).toContain("Task lifecycle:");
      expect(result.text).toContain("replan required");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("fails closed with a new-task recovery command when lifecycle state is invalid", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-invalid-lifecycle",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const lifecycleDir = path.join(repo, ".codex/cache/codexa-task-lifecycle");
      const [lifecycleFile] = await readdir(lifecycleDir);
      await writeFile(path.join(lifecycleDir, lifecycleFile!), "{malformed\n", "utf8");

      const result = await proveQuery(repo, { taskId: "prove-invalid-lifecycle", autoRefresh: false });
      const data = result.data as ProveData;
      expect(data.lifecycle.status).toBe("invalid");
      expect(result.text).toContain("Status: blocked");
      expect(data.nextCommands).toHaveLength(1);
      expect(data.nextCommands[0]).toContain("codexa change-plan");
      expect(data.nextCommands[0]).toContain("--task-id '<new-task-id>'");
      expect(data.nextCommands[0]).not.toContain("post-edit-review");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("requires a fresh review when the worktree changes after a resolved attempt", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-resolved-drift",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      await writeFile(
        path.join(repo, "src/widget.ts"),
        "export function widget() { return 'reviewed' }\n",
        "utf8"
      );
      const reviewed = await postEditReviewQuery(
        repo,
        {
          taskId: "prove-resolved-drift",
          ranCommands: ["npm test", "npm run typecheck"],
          persistOutcome: true
        },
        { autoRefresh: true }
      );
      expect((reviewed.data as { loopReview?: { attemptStatus?: string } }).loopReview?.attemptStatus).toBe(
        "resolved"
      );

      const evidenceFreeProof = await proveQuery(repo, {
        taskId: "prove-resolved-drift",
        autoRefresh: false
      });
      const evidenceFreeData = evidenceFreeProof.data as ProveData;
      expect(evidenceFreeData.lifecycle.resolvedAttemptDrift).toBeUndefined();
      expect(evidenceFreeData.gaps).toContain(
        "resolved lifecycle history is not explicit verification evidence in the current proof packet"
      );
      expect(
        evidenceFreeData.nextCommands.some(
          (command) => command.includes("post-edit-review") && command.includes("<command-you-ran>")
        )
      ).toBe(true);
      expect(evidenceFreeProof.text).not.toContain("Status: ready");

      await writeFile(
        path.join(repo, "src/widget.ts"),
        "export function widget() { return 'changed-after-review' }\n",
        "utf8"
      );
      const proof = await proveQuery(repo, { taskId: "prove-resolved-drift", autoRefresh: true });
      const data = proof.data as ProveData;
      expect(data.lifecycle.resolvedAttemptDrift).toMatchObject({
        attemptId: expect.any(String),
        reason: expect.stringContaining("does not exactly match")
      });
      expect(
        data.gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))
      ).toBe(true);
      expect(
        data.nextCommands.some(
          (command) => command.includes("post-edit-review") && command.includes("<command-you-ran>")
        )
      ).toBe(true);
      expect(proof.text).not.toContain("Status: ready");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("never reports a dirty worktree as clean when diff planning is disabled", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await writeFile(path.join(repo, "src/widget.ts"), "export function widget() { return 'dirty' }\n", "utf8");

      const proof = await proveQuery(repo, {
        task: "inspect current dirty repo",
        diff: false,
        autoRefresh: false
      });
      const data = proof.data as ProveData;
      expect(data.worktree.knownClean).toBe(false);
      expect(data.worktree.unknown).toBe(false);
      expect(data.worktree.dirtyFileCount).toBeGreaterThan(0);
      expect(data.worktree.changedFiles).toContain("src/widget.ts");
      expect(proof.text).not.toContain("Worktree: clean");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("invalidates resolved review authority when the saved plan revision advances", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-plan-revision-drift",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      await writeFile(path.join(repo, "src/widget.ts"), "export function widget() { return 'reviewed' }\n", "utf8");
      const reviewed = await postEditReviewQuery(
        repo,
        {
          taskId: "prove-plan-revision-drift",
          ranCommands: ["npm test", "npm run typecheck"],
          persistOutcome: true
        },
        { autoRefresh: true }
      );
      expect((reviewed.data as { loopReview?: { attemptStatus?: string } }).loopReview?.attemptStatus).toBe("resolved");

      await changePlanQuery(
        repo,
        {
          task: "change widget behavior again",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-plan-revision-drift",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const proof = await proveQuery(repo, {
        taskId: "prove-plan-revision-drift",
        autoRefresh: false
      });
      const data = proof.data as ProveData;
      expect(data.lifecycle.resolvedAttemptDrift).toMatchObject({
        attemptId: expect.any(String),
        reason: expect.stringContaining("current plan")
      });
      expect(data.nextCommands.some((command) => command.includes("post-edit-review"))).toBe(true);
      expect(proof.text).not.toContain("Status: ready");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps evidence-free resolved proofs actionable when no command can be rediscovered", async () => {
    const repo = await createProofFixtureRepo();
    try {
      await rm(path.join(repo, "package.json"));
      await rm(path.join(repo, "tests"), { recursive: true });
      execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Codexa Test", "-c", "user.email=codexa@example.invalid", "commit", "-m", "minimal fixture"],
        { cwd: repo, stdio: "ignore" }
      );
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change standalone widget",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-evidence-dead-end",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      await writeFile(path.join(repo, "src/widget.ts"), "export function widget() { return 'reviewed' }\n", "utf8");
      const reviewed = await postEditReviewQuery(
        repo,
        {
          taskId: "prove-evidence-dead-end",
          ranCommands: ["tsc --noEmit src/widget.ts"],
          persistOutcome: true
        },
        { autoRefresh: true }
      );
      expect((reviewed.data as { loopReview?: { attemptStatus?: string } }).loopReview?.attemptStatus).toBe("resolved");

      const proof = await proveQuery(repo, {
        taskId: "prove-evidence-dead-end",
        autoRefresh: false
      });
      const data = proof.data as ProveData;
      expect(data.verification.recommendedCommands).toEqual([]);
      expect(data.gaps).toContain(
        "resolved lifecycle history is not explicit verification evidence in the current proof packet"
      );
      const handoff = data.nextCommands.find((command) => command.includes("post-edit-review"));
      expect(handoff).toContain("<command-you-ran>");
      expect(proof.text).not.toContain("Status: ready");
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
      expect(unscopedData.nextCommands).toEqual([]);
      expect(unscoped.text).toContain("Actionability: needs_target");
      expect(unscoped.text).toContain("Status: needs target");
      expect(unscoped.text).toContain(`Proof gaps: ${unscopedData.gaps.length}`);
      expect(unscoped.text).toContain("Next action:");
      expect(unscoped.text).not.toContain("Reported verification evidence:");
      expect(unscoped.text).not.toContain("Reported verification ledger:");
      expect(unscoped.text).not.toContain("External verification artifacts:");
      expect(unscoped.text).not.toContain("Decision log:");

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
        files: ["src/widget.ts"],
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
      expect(data.verification.ledgerPreview.every((entry) => entry.trustTier === "none")).toBe(true);
      expect(data.verification.reported.coverage.every((entry) => entry.trustTier === "reported")).toBe(true);
      expect(data.verification.reported.commandPlan.every((entry) => entry.trustTier === "reported")).toBe(true);
      expect(data.verification.reported.ledger.some((entry) => entry.target === "tests/widget.test.ts" && entry.status === "covered" && entry.trustTier === "reported")).toBe(true);
      expect(data.verification.reported.testsNotRun.map((test) => test.path)).not.toContain("tests/widget.test.ts");
      expect(data.verification.reported.commandEnvelopes[0]).toMatchObject({ command: "npm test", cwd: "<repo>", packageManager: "npm", scriptName: "test" });
      expect(serializedReported).not.toContain(outside);
      expect(serializedReported).toContain("<abs-path>");
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("preserves package-scoped command reports in the post-edit handoff", async () => {
    const repo = await createMonorepoProofFixtureRepo();
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change the foo widget",
          files: ["packages/foo/src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-package-scope",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const report = {
        command: `npm test -- ${path.join(repo, "packages/foo/tests/foo.test.ts")}`,
        cwd: path.join(repo, "packages/foo"),
        packageManager: "npm",
        packageRoot: "packages/foo",
        scriptName: "test",
        args: [path.join(repo, "packages/foo/tests/foo.test.ts")],
        exitCode: 0
      };
      const first = await proveQuery(repo, {
        taskId: "prove-package-scope",
        autoRefresh: false,
        ranCommandReports: [report]
      });
      const firstData = first.data as ProveData;
      const handoff = firstData.nextCommands.find((command) => command.includes("post-edit-review"));
      expect(handoff).toContain("--ran-command-report");
      expect(handoff).not.toContain("--ran-command 'npm test'");
      const serializedReport = handoff?.match(/--ran-command-report '([^']+)'/u)?.[1];
      expect(serializedReport).toBeTruthy();
      const handedOffReport = JSON.parse(serializedReport ?? "{}") as typeof report;
      expect(handedOffReport).toMatchObject({
        command: `npm test -- ${path.join(repo, "packages/foo/tests/foo.test.ts")}`,
        cwd: "packages/foo",
        packageRoot: "packages/foo",
        args: [path.join(repo, "packages/foo/tests/foo.test.ts")],
        exitCode: 0
      });

      const roundTripped = await proveQuery(repo, {
        taskId: "prove-package-scope",
        autoRefresh: false,
        ranCommandReports: [handedOffReport]
      });
      const roundTrippedData = roundTripped.data as ProveData;
      expect(roundTrippedData.verification.reported.commandEnvelopes[0]).toMatchObject({
        cwd: "packages/foo",
        packageRoot: "packages/foo",
        scopeStatus: "repo"
      });
      expect(
        roundTrippedData.verification.reported.coverage
          .map((entry) => entry.scope)
      ).toContain("packages/foo");
      expect(roundTrippedData.verification.reported.coverage.map((entry) => entry.scope)).not.toContain(".");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not forward an outside-repository command report as in-repo proof", async () => {
    const repo = await createProofFixtureRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-prove-handoff-outside-"));
    try {
      await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-outside-scope",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const result = await proveQuery(repo, {
        taskId: "prove-outside-scope",
        autoRefresh: false,
        ranCommandReports: [
          {
            command: "npm test",
            cwd: outside,
            packageManager: "npm",
            packageRoot: ".",
            scriptName: "test",
            args: [],
            exitCode: 0
          }
        ]
      });
      const data = result.data as ProveData;
      expect(data.verification.reported.commandEnvelopes[0]?.scopeStatus).toBe("outside-repo");
      expect(
        data.verification.reported.ledger.some(
          (entry) => entry.target === "tests/widget.test.ts" && entry.status === "covered"
        )
      ).toBe(false);
      const handoff = data.nextCommands.find((command) => command.includes("post-edit-review"));
      expect(handoff).toBeTruthy();
      expect(handoff).not.toContain("--ran-command-report");
      expect(handoff).not.toContain("--ran-command 'npm test'");

      const outsideTarget = path.join(outside, "outside.test.ts");
      const outsideSelector = await proveQuery(repo, {
        taskId: "prove-outside-scope",
        autoRefresh: false,
        ranCommandReports: [
          {
            command: `vitest run ${outsideTarget}`,
            cwd: repo,
            packageManager: "vitest",
            packageRoot: ".",
            scriptName: "vitest",
            args: ["run", outsideTarget],
            exitCode: 0
          }
        ]
      });
      const outsideSelectorData = outsideSelector.data as ProveData;
      expect(
        outsideSelectorData.verification.reported.ledger.some(
          (entry) => entry.target === "tests/widget.test.ts" && entry.status === "covered"
        )
      ).toBe(false);
      expect(
        outsideSelectorData.nextCommands.find((command) => command.includes("post-edit-review"))
      ).not.toContain("--ran-command-report");
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
        files: ["src/widget.ts"],
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
        files: ["src/widget.ts"],
        autoRefresh: false,
        waivers: [{ kind: "test", target: "tests/widget.test.ts", reason: "manual browser regression" }]
      });
      const waivedData = waived.data as ProveData;
      expect(waivedData.verification.reported.ledger.some((entry) => entry.target === "tests/widget.test.ts" && entry.status === "waived")).toBe(true);
      expect(waivedData.verification.reported.ledger.find((entry) => entry.target === "tests/widget.test.ts")?.trustTier).toBe("none");
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
      expect(data.nextCommands).toContain(
        `codexa verification-artifact '${repo}' --file '<state-bound-verification-summary.json>'`
      );
      expect(
        data.nextCommands.some(
          (command) =>
            command.includes("post-edit-review") &&
            command.includes("--artifact-id '<artifact-id-from-verification-artifact>'")
        )
      ).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("credits an exact state-bound verification artifact without promoting it to test coverage", async () => {
    const repo = await createProofFixtureRepo();
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "codexa-proof-artifact-source-"));
    try {
      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-artifact",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/prove-artifact.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { requiredWorkflowChecks?: unknown[] };
      snapshot.requiredWorkflowChecks = [
        {
          kind: "workflow",
          target: "live-smoke",
          reason: "Live smoke must pass",
          evidenceTier: "derived",
          confidence: "derived",
          paths: ["src/widget.ts"]
        }
      ];
      await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
      const artifactSource = path.join(sourceDir, "summary.json");
      await writeFile(
        artifactSource,
        JSON.stringify({
          schemaVersion: 1,
          kind: "codexa-verification-summary",
          binding: {
            taskId: "prove-artifact",
            headCommit: index.freshness.headCommit,
            workspaceStateDigest: workspaceStateDigest(index.freshness)
          },
          run: { id: "live-run-1", category: "live-validation", outcome: "passed" },
          checks: [{ kind: "workflow", target: "live-smoke", outcome: "passed" }]
        }),
        "utf8"
      );
      const ingested = await ingestVerificationArtifact(repo, artifactSource);

      const result = await proveQuery(repo, {
        task: "change widget behavior",
        taskId: "prove-artifact",
        changeType: "behavior",
        files: ["src/widget.ts"],
        artifactIds: [ingested.record.artifactId],
        autoRefresh: false
      });
      const data = result.data as ProveData;

      expect(data.verification.artifacts.accepted).toHaveLength(1);
      expect(data.verification.reported.ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "workflow", target: "live-smoke", status: "covered", trustTier: "reported" }),
          expect.objectContaining({ kind: "test", target: "tests/widget.test.ts", status: "missing", trustTier: "none" })
        ])
      );
      expect(data.gaps).not.toContain("reported verification missing: workflow live-smoke");
      expect(data.gaps).toContain("reported verification missing: tests/widget.test.ts");
      expect(result.text).toContain(`accepted: ${ingested.record.artifactId}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("loads the decision log from the snapshot-bound session instead of the latest session", async () => {
    const repo = await createProofFixtureRepo();
    try {
      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "session-a",
        taskId: "prove-memory",
        freshness: index.freshness,
        entries: [
          {
            kind: "decision",
            key: "decision:bounded-artifacts",
            summary: "Use bounded verification artifacts.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          },
          {
            kind: "constraint",
            key: "invariant:no-fixtures",
            summary: "Do not add fixture-specific behavior. TOKEN=hidden-value",
            provenance: "user-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          taskId: "prove-memory",
          changeType: "behavior"
        },
        { autoRefresh: false }
      );
      const historicalArtifactId = `va_${"a".repeat(64)}`;
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "session-a",
        taskId: "prove-memory",
        freshness: index.freshness,
        source: "codexa_cache",
        toolName: "verification_artifact",
        entries: [
          {
            kind: "verification",
            key: "run:historical",
            summary: "Historical artifact reference.",
            provenance: "codexa-derived",
            confidence: "derived",
            evidenceTier: "derived",
            scope: {
              refs: [{ kind: "verification_artifact", id: historicalArtifactId, evidenceTier: "derived", confidence: "derived" }]
            }
          }
        ]
      });
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "session-a",
        taskId: "prove-memory",
        freshness: index.freshness,
        entries: [
          {
            kind: "ruled_out",
            key: "ruled-out:post-plan",
            summary: "Do not add a second artifact store.",
            status: "rejected",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      await compactSessionMemory({ repoRoot: repo, sessionId: "session-a", freshness: index.freshness });
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "session-b",
        taskId: "other-task",
        freshness: index.freshness,
        entries: [
          {
            kind: "decision",
            summary: "This belongs to another session.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });

      const result = await proveQuery(repo, { taskId: "prove-memory", task: "change widget behavior", autoRefresh: false });
      const data = result.data as ProveData;
      expect(data.decisionLog).toMatchObject({ status: "loaded", sessionId: "session-a", baselineIntact: true, summaryHashValid: true });
      expect(data.decisionLog.decisions.map((entry) => entry.summary)).toContain("Use bounded verification artifacts.");
      expect(data.decisionLog.ruledOut.map((entry) => entry.summary)).toContain("Do not add a second artifact store.");
      expect(data.decisionLog.constraints.map((entry) => entry.summary)).toContain("Do not add fixture-specific behavior. TOKEN=<redacted>");
      expect(JSON.stringify(data.decisionLog)).not.toContain("hidden-value");
      expect(JSON.stringify(data.decisionLog)).not.toContain("This belongs to another session.");
      expect(data.decisionLog.artifactIds).toContain(historicalArtifactId);
      expect(data.verification.artifacts.selected).toEqual([]);

      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "session-a",
        taskId: "prove-memory",
        freshness: index.freshness,
        entries: [
          {
            kind: "decision",
            key: "decision:bounded-artifacts",
            summary: "Changed decision content.",
            provenance: "agent-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic"
          }
        ]
      });
      const changed = await proveQuery(repo, { taskId: "prove-memory", task: "change widget behavior", autoRefresh: false });
      expect((changed.data as ProveData).decisionLog.summaryHashValid).toBe(false);
      expect((changed.data as ProveData).gaps).toContain("task-bound decision log content differs from the plan-time canonical digest");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("allocates the final task id before binding plan memory to the active workspace session", async () => {
    const repo = await createProofFixtureRepo();
    try {
      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await recordSessionMemory({
        repoRoot: repo,
        sessionId: "workspace-session",
        freshness: index.freshness,
        entries: [
          {
            kind: "constraint",
            summary: "Keep the public behavior stable.",
            provenance: "user-asserted",
            confidence: "heuristic",
            evidenceTier: "heuristic",
            scope: { files: ["src/widget.ts"] }
          }
        ]
      });
      const planned = await changePlanQuery(
        repo,
        {
          task: "change widget behavior",
          files: ["src/widget.ts"],
          saveSnapshot: true,
          changeType: "behavior"
        },
        { autoRefresh: false, workspaceSessionId: "workspace-session" }
      );
      const snapshot = (planned.data as { snapshot?: { taskId?: string; input?: { taskId?: string }; sessionMemory?: { sessionId?: string; summaryHash?: string } } }).snapshot;
      expect(snapshot?.taskId).toBeTruthy();
      expect(snapshot?.input?.taskId).toBe(snapshot?.taskId);
      expect(snapshot?.sessionMemory).toMatchObject({ sessionId: "workspace-session", summaryHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
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
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa Test", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createMonorepoProofFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-prove-monorepo-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "codexa-prove-monorepo", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
    "utf8"
  );
  for (const packageName of ["foo", "bar"]) {
    const packageRoot = path.join(repo, "packages", packageName);
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
    await mkdir(path.join(packageRoot, "tests"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: `@fixture/${packageName}`,
        scripts: { test: `vitest run tests/${packageName}.test.ts` }
      }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(packageRoot, "src/widget.ts"),
      `export const widget = ${JSON.stringify(packageName)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(packageRoot, `tests/${packageName}.test.ts`),
      "import { widget } from '../src/widget'\nexport const result = widget\n",
      "utf8"
    );
  }
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa Test", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}
