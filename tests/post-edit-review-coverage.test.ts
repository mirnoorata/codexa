import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { latestCompletedPostEditReviewMatches } from "../src/post-edit-outcomes.js";
import { createPostEditReviewCoverage, postEditReviewTargetDigest } from "../src/post-edit-review-coverage.js";
import { proveQuery } from "../src/prove.js";
import { postEditDecision } from "../src/query/post-edit/decision.js";
import { hasRelevantVerificationEvidence } from "../src/query/post-edit/support.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";

describe("post-edit review target coverage", () => {
  it("requires Cypress runner provenance for fallback verification relevance", () => {
    const cypressPath = "cypress/e2e/login.cy.ts";
    const base = {
      verificationLedger: [],
      ranTests: [],
      tests: [],
      workflowChecks: [],
      dependencyChecks: [],
      reviewTargets: [cypressPath],
      editPaths: [cypressPath]
    };
    const coverage = (testRunner: "vitest" | "playwright" | "cypress", targeted: boolean) => ({
      kind: "javascript-tests" as const,
      command: `${testRunner} run`,
      source: testRunner,
      confidence: "authoritative" as const,
      trustTier: "reported" as const,
      scope: ".",
      ...(targeted ? { targetPath: cypressPath } : {}),
      testRunner,
      details: []
    });

    for (const wrongRunner of ["vitest", "playwright"] as const) {
      expect(
        hasRelevantVerificationEvidence({
          ...base,
          verificationCoverage: [coverage(wrongRunner, false)]
        })
      ).toBe(false);
      expect(
        hasRelevantVerificationEvidence({
          ...base,
          verificationCoverage: [coverage(wrongRunner, true)]
        })
      ).toBe(false);
    }
    expect(
      hasRelevantVerificationEvidence({
        ...base,
        verificationCoverage: [coverage("cypress", false)]
      })
    ).toBe(true);
    expect(
      hasRelevantVerificationEvidence({
        ...base,
        verificationCoverage: [coverage("cypress", true)]
      })
    ).toBe(true);
  });

  it("covers more targets than the per-pass limit and persists the aggregate receipt", async () => {
    const { repo, files } = await createManyFileRepo(11);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "partial-review-coverage");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "partial-review-coverage",
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"]
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      verdict: string;
      inspectMode: string;
      inspectReasons: string[];
      completionAuthority: string;
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: {
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
        analysisPassCount: number;
        schemaVersion: number;
        binding: { taskId: string; planRevision: number; candidateTargetsDigest: string; analyzedTargetsDigest: string };
      };
      outcome: { persisted: boolean; reviewCoverage: { status: string; omittedTargetCount: number } };
      failureSignals: Array<{ class: string; targets: string[] }>;
    };

    expect(data.reviewCandidateTargets).toHaveLength(11);
    expect(data.reviewTargets).toHaveLength(11);
    expect(data.reviewCoverage).toMatchObject({
      schemaVersion: 2,
      status: "complete",
      candidateTargetCount: 11,
      analyzedTargetCount: 11,
      omittedTargetCount: 0,
      targetLimit: 10,
      analysisPassCount: 2,
      binding: { taskId: "partial-review-coverage", planRevision: 1 }
    });
    expect(data.reviewCoverage.binding.candidateTargetsDigest).toMatch(/^[a-f0-9]{16}$/u);
    expect(data.reviewCoverage.binding.analyzedTargetsDigest).toMatch(/^[a-f0-9]{16}$/u);
    expect(data.inspectReasons).not.toContain("1 candidate review target(s) were not analyzed");
    expect(["complete", "advisory_inspect"]).toContain(data.completionAuthority);
    expect(data.outcome).toMatchObject({
      persisted: true,
      reviewCoverage: { status: "complete", omittedTargetCount: 0 }
    });
    expect(data.failureSignals.flatMap((signal) => signal.targets)).not.toContain("post-edit-review-scope:1-target(s)-omitted");
    expect(review.text).toContain("analyzed across 2 bounded passes; none omitted");
    const initialProof = await proveQuery(repo, {
      taskId: "partial-review-coverage",
      autoRefresh: false
    });
    expect(
      (initialProof.data as { gaps: string[] }).gaps.some((gap) => gap.startsWith("latest post-edit review is unresolved:"))
    ).toBe(false);

    const persisted = JSON.parse(
      await readFile(path.join(repo, ".codex/cache/codexa-outcomes", `${(data.outcome as { outcomeId?: string }).outcomeId}.json`), "utf8")
    );
    expect(persisted.reviewCoverage).toEqual(data.reviewCoverage);

    const completeScope = await postEditReviewQuery(
      repo,
      {
        taskId: "partial-review-coverage",
        limit: 30,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"]
      },
      { autoRefresh: false }
    );
    const completeData = completeScope.data as {
      reviewCoverage: {
        schemaVersion: 2;
        binding: Record<string, unknown>;
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
        analysisPassCount: number;
      };
      inspectReasons: string[];
      completionAuthority: string;
      outcome: {
        outcomeId: string;
        path: string;
        planRevision: number;
        snapshotCreatedAt?: string;
        snapshotPublicationSequence?: number;
      };
    };
    expect(completeData.reviewCoverage).toMatchObject({
      schemaVersion: 2,
      status: "complete",
      candidateTargetCount: 11,
      analyzedTargetCount: 11,
      omittedTargetCount: 0,
      targetLimit: 30,
      analysisPassCount: 1
    });
    expect(completeData.inspectReasons).not.toContain("1 candidate review target(s) were not analyzed");
    const completeProof = await proveQuery(repo, {
      taskId: "partial-review-coverage",
      autoRefresh: false
    });
    expect(
      (completeProof.data as { gaps: string[] }).gaps.some((gap) => gap.startsWith("latest post-edit review is unresolved:"))
    ).toBe(false);
    expect(["complete", "advisory_inspect"]).toContain(completeData.completionAuthority);
    const completionIdentity = {
      repoRoot: repo,
      freshness: completeScope.freshness,
      taskId: "partial-review-coverage",
      planRevision: completeData.outcome.planRevision,
      snapshotCreatedAt: completeData.outcome.snapshotCreatedAt,
      snapshotPublicationSequence: completeData.outcome.snapshotPublicationSequence
    };
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(true);

    const completeOutcomePath = path.join(repo, completeData.outcome.path);
    const authoritativeOutcomeText = await readFile(completeOutcomePath, "utf8");
    const redirectedOutcome = path.join(repo, ".codex", "cache", "redirected-outcome.json");
    await writeFile(redirectedOutcome, authoritativeOutcomeText, "utf8");
    await unlink(completeOutcomePath);
    await link(redirectedOutcome, completeOutcomePath);
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);
    await unlink(completeOutcomePath);
    await writeFile(completeOutcomePath, authoritativeOutcomeText, "utf8");
    if (process.platform !== "win32") {
      await unlink(completeOutcomePath);
      await symlink(redirectedOutcome, completeOutcomePath);
      expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);
      await unlink(completeOutcomePath);
      await writeFile(completeOutcomePath, authoritativeOutcomeText, "utf8");
    }
    const legacyOutcome = JSON.parse(await readFile(completeOutcomePath, "utf8"));
    const validVerificationProvenance = legacyOutcome.verificationProvenance;
    delete legacyOutcome.verificationProvenance;
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);

    legacyOutcome.verificationProvenance = { ...validVerificationProvenance };
    delete legacyOutcome.verificationProvenance.commandCoverageClassifier;
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);

    legacyOutcome.verificationProvenance = {
      ...CURRENT_VERIFICATION_PROVENANCE,
      commandCoverageClassifierVersion: "command-coverage-v6",
      verificationCoverageVersion: "verification-coverage-v4",
      verificationLedgerVersion: "verification-ledger-v3"
    };
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);
    legacyOutcome.verificationProvenance = validVerificationProvenance;

    const validCompleteCoverage = legacyOutcome.reviewCoverage;
    delete legacyOutcome.reviewCoverage;
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);

    legacyOutcome.reviewCoverage = {
      schemaVersion: 1,
      binding: data.reviewCoverage.binding,
      status: "partial",
      candidateTargetCount: 11,
      analyzedTargetCount: 10,
      omittedTargetCount: 1,
      targetLimit: 10
    };
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);

    legacyOutcome.reviewCoverage = {
      ...validCompleteCoverage,
      candidateTargetCount: 31,
      analyzedTargetCount: 31,
      targetLimit: 3
    };
    await writeFile(completeOutcomePath, `${JSON.stringify(legacyOutcome, null, 2)}\n`, "utf8");
    expect(await latestCompletedPostEditReviewMatches(completionIdentity)).toBe(false);
  });

  it("keeps a resolved review current after committing the exact reviewed workspace", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const taskId = "exact-reviewed-commit";
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, taskId);
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      { taskId, ranCommands: ["npm run typecheck"] },
      { autoRefresh: true }
    );
    expect(["complete", "advisory_inspect"]).toContain(
      (review.data as { completionAuthority: string }).completionAuthority
    );
    execFileSync("git", ["add", "--", ...files], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "commit reviewed change"],
      { cwd: repo, stdio: "ignore" }
    );

    const proof = await proveQuery(repo, {
      taskId,
      ranCommands: ["npm run typecheck"],
      autoRefresh: true
    });
    const proofData = proof.data as {
      worktree: { knownClean: boolean };
      lifecycle: { resolvedAttemptDrift?: { attemptId: string } };
      gaps: string[];
    };
    expect(proofData.worktree.knownClean).toBe(true);
    expect(proofData.lifecycle.resolvedAttemptDrift).toBeUndefined();
    expect(proofData.gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))).toBe(false);
  });

  it("rejects a clean commit whose content changed after the review", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const taskId = "modified-after-reviewed-commit";
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, taskId);
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      { taskId, ranCommands: ["npm run typecheck"] },
      { autoRefresh: true }
    );
    expect(["complete", "advisory_inspect"]).toContain(
      (review.data as { completionAuthority: string }).completionAuthority
    );
    await writeFile(path.join(repo, files[0]!), "export const value0 = 999;\n", "utf8");
    execFileSync("git", ["add", "--", ...files], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "commit later change"],
      { cwd: repo, stdio: "ignore" }
    );

    const proof = await proveQuery(repo, {
      taskId,
      ranCommands: ["npm run typecheck"],
      autoRefresh: true
    });
    const proofData = proof.data as {
      lifecycle: { resolvedAttemptDrift?: { attemptId: string } };
      gaps: string[];
    };
    expect(proofData.lifecycle.resolvedAttemptDrift?.attemptId).toBeTruthy();
    expect(proofData.gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))).toBe(true);
  });

  it("rejects a status-hidden worktree edit after committing the reviewed tree", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const taskId = "assume-unchanged-after-reviewed-commit";
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, taskId);
    await editFiles(repo, files);
    const review = await postEditReviewQuery(repo, { taskId, ranCommands: ["npm run typecheck"] }, { autoRefresh: true });
    expect(["complete", "advisory_inspect"]).toContain((review.data as { completionAuthority: string }).completionAuthority);
    execFileSync("git", ["add", "--", ...files], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "commit reviewed change"],
      { cwd: repo, stdio: "ignore" }
    );
    execFileSync("git", ["update-index", "--assume-unchanged", "--", files[0]!], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, files[0]!), "export const value0 = 777;\n", "utf8");
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" })).toBe("");

    const proof = await proveQuery(repo, { taskId, ranCommands: ["npm run typecheck"], autoRefresh: true });
    const proofData = proof.data as { lifecycle: { resolvedAttemptDrift?: { attemptId: string } }; gaps: string[] };
    expect(proofData.lifecycle.resolvedAttemptDrift?.attemptId).toBeTruthy();
    expect(proofData.gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))).toBe(true);
  });

  it("binds the raw reviewed bytes across Git EOL normalization", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const taskId = "eol-normalized-reviewed-commit";
    await writeFile(path.join(repo, ".gitattributes"), "*.ts text eol=lf\n", "utf8");
    execFileSync("git", ["add", ".gitattributes"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add text normalization"],
      { cwd: repo, stdio: "ignore" }
    );
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, taskId);
    await writeFile(path.join(repo, files[0]!), "export const value0 = 42;\r\nexport const marker = true;\n", "utf8");
    const review = await postEditReviewQuery(repo, { taskId, ranCommands: ["npm run typecheck"] }, { autoRefresh: true });
    expect(["complete", "advisory_inspect"]).toContain((review.data as { completionAuthority: string }).completionAuthority);
    execFileSync("git", ["add", "--", ...files], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "commit normalized change"],
      { cwd: repo, stdio: "ignore" }
    );
    const accepted = await proveQuery(repo, { taskId, ranCommands: ["npm run typecheck"], autoRefresh: true });
    expect((accepted.data as { gaps: string[] }).gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))).toBe(false);

    await writeFile(path.join(repo, files[0]!), "export const value0 = 42;\nexport const marker = true;\r\n", "utf8");
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" })).toBe("");
    const rejected = await proveQuery(repo, { taskId, ranCommands: ["npm run typecheck"], autoRefresh: true });
    expect((rejected.data as { gaps: string[] }).gaps.some((gap) => gap.startsWith("worktree changed since resolved post-edit review:"))).toBe(true);
  });

  it("analyzes a broad maximum-limit review in bounded exhaustive passes", async () => {
    const { repo, files } = await createManyFileRepo(61);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "maximum-partial-review-coverage");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "maximum-partial-review-coverage",
        limit: 30,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewTargets: string[];
      reviewCoverage: {
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
        analysisPassCount: number;
      };
      nextActions: string[];
    };
    expect(data.reviewTargets).toEqual([...files].sort((a, b) => a.localeCompare(b)));
    expect(data.reviewCoverage).toMatchObject({
      status: "complete",
      candidateTargetCount: 61,
      analyzedTargetCount: 61,
      omittedTargetCount: 0,
      targetLimit: 30,
      analysisPassCount: 3
    });
    expect(data.inspectReasons.some((reason) => reason.includes("candidate review target(s) were not analyzed"))).toBe(false);
    expect(["complete", "advisory_inspect"]).toContain(data.completionAuthority);
    expect(review.text).toContain("analyzed across 3 bounded passes; none omitted");
    expect(data.nextActions[0]).not.toContain("Narrow or split");
    expect(review.text).not.toContain("Raise limit to widen");
  });

  it("lets a later bounded pass contribute blocking risk evidence", async () => {
    const { repo, files } = await createManyFileRepo(31);
    const lateBatchFile = files[files.length - 1]!;
    await addStaticRisk(repo, lateBatchFile);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "late-batch-risk-coverage");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "late-batch-risk-coverage",
        limit: 30,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      inspectReasons: string[];
      reviewCoverage: { status: string; analysisPassCount: number; omittedTargetCount: number };
      riskEscalations: Array<{ path: string }>;
    };
    expect(data.reviewCoverage).toMatchObject({ status: "complete", analysisPassCount: 2, omittedTargetCount: 0 });
    expect(data.riskEscalations).toEqual(expect.arrayContaining([expect.objectContaining({ path: lateBatchFile })]));
    expect(data.inspectReasons.some((reason) => reason.includes("candidate review target(s) were not analyzed"))).toBe(false);
  });

  it("keeps broad-scope work linear while completing more than twelve logical passes", async () => {
    const { repo, files } = await createManyFileRepo(121);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "bounded-pass-budget");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "bounded-pass-budget",
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewTargets: string[];
      reviewCoverage: {
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
        analysisPassCount: number;
      };
      nextActions: string[];
    };
    expect(data.reviewTargets).toEqual([...files].sort((a, b) => a.localeCompare(b)));
    expect(data.reviewCoverage).toMatchObject({
      status: "complete",
      candidateTargetCount: 121,
      analyzedTargetCount: 121,
      omittedTargetCount: 0,
      targetLimit: 10,
      analysisPassCount: 13
    });
    expect(data.inspectReasons).not.toContain("1 candidate review target(s) were not analyzed");
    expect(["complete", "advisory_inspect"]).toContain(data.completionAuthority);
  });

  it("reserves every explicit pass target ahead of higher-ranked graph expansion", async () => {
    const { repo, files } = await createManyFileRepo(10);
    await addImportHub(repo, files);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "explicit-focus-reservation");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "explicit-focus-reservation",
        limit: 10,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true, maxResults: 3 }
    );
    const data = review.data as {
      reviewCoverage: {
        status: string;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
        analysisPassCount: number;
      };
      context: { focusFiles: Array<{ file: { path: string } }> };
    };
    expect(data.reviewCoverage).toMatchObject({
      status: "complete",
      analyzedTargetCount: 10,
      omittedTargetCount: 0,
      targetLimit: 3,
      analysisPassCount: 4
    });
    expect(data.context.focusFiles.map((entry) => entry.file.path)).toEqual(expect.arrayContaining(files));
  });

  it("keeps a missing explicit symbol in broad-scope fail-closed coverage", async () => {
    const { repo, files } = await createManyFileRepo(11);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "broad-missing-symbol");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "broad-missing-symbol",
        symbols: ["definitelyMissingSymbol"],
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: {
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        analysisPassCount: number;
      };
    };
    const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));
    expect(data.reviewCandidateTargets).toEqual([
      ...sortedFiles,
      expect.stringMatching(/^\/@codexa\/unresolved-symbol\/0\//u)
    ]);
    expect(data.reviewTargets).toEqual(sortedFiles);
    expect(data.reviewCoverage).toMatchObject({
      status: "partial",
      candidateTargetCount: 12,
      analyzedTargetCount: 11,
      omittedTargetCount: 1,
      analysisPassCount: 2
    });
    expect(data.inspectReasons).toContain("1 candidate review target(s) were not analyzed");
    expect(data.completionAuthority).toBe("blocking_inspect");
  });

  it("cannot satisfy an unresolved symbol with a colliding indexed file path", async () => {
    const { repo, files } = await createManyFileRepo(1);
    await addTrackedFile(repo, "symbol:trap.ts", "export const trap = true;\n");
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "symbol-path-collision");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "symbol-path-collision",
        symbols: ["trap.ts"],
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; omittedTargetCount: number };
    };
    expect(data.reviewCandidateTargets).toEqual([
      files[0],
      expect.stringMatching(/^\/@codexa\/unresolved-symbol\/0\//u)
    ]);
    expect(data.reviewTargets).toEqual(files);
    expect(data.reviewCoverage).toMatchObject({ status: "partial", omittedTargetCount: 1 });
    expect(data.completionAuthority).toBe("blocking_inspect");
  });

  it("fails closed instead of crashing on a malformed UTF-16 symbol", async () => {
    const { repo, files } = await createManyFileRepo(1);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "malformed-symbol");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "malformed-symbol",
        symbols: ["\ud800"],
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; omittedTargetCount: number };
    };
    expect(data.reviewCandidateTargets[1]).toMatch(/^\/@codexa\/unresolved-symbol\/0\/[a-f0-9]{16}$/u);
    expect(data.reviewTargets).toEqual(files);
    expect(data.reviewCoverage).toMatchObject({ status: "partial", omittedTargetCount: 1 });
    expect(data.completionAuthority).toBe("blocking_inspect");
  });

  it("keeps every directly relevant test in completion authority after display limits", async () => {
    const { repo, sourceFile, testFiles } = await createManyTestRepo(13);
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      {
        task: "Change the shared behavior covered by every direct test",
        files: [sourceFile],
        diff: false,
        limit: 30,
        saveSnapshot: true,
        taskId: "full-test-authority"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, sourceFile), "export const value = 2;\n", "utf8");

    const partialTests = await postEditReviewQuery(
      repo,
      {
        taskId: "full-test-authority",
        tokenBudget: 10_000,
        ranTests: testFiles.slice(0, 12),
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const partialData = partialTests.data as {
      completionAuthority: string;
      tests: Array<{ path: string }>;
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string }>;
    };
    const finalTest = testFiles[testFiles.length - 1]!;
    expect(partialData.tests.map((test) => test.path)).toEqual(expect.arrayContaining(testFiles));
    expect(partialData.testsNotRun.map((test) => test.path)).toContain(finalTest);
    expect(partialData.verificationLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "test", target: finalTest, status: "missing" })
      ])
    );
    expect(partialData.completionAuthority).toBe("tests_required");

    const allTests = await postEditReviewQuery(
      repo,
      {
        taskId: "full-test-authority",
        tokenBudget: 10_000,
        ranTests: testFiles,
        persistOutcome: false
      },
      { autoRefresh: false }
    );
    const allData = allTests.data as {
      completionAuthority: string;
      testsNotRun: Array<{ path: string }>;
    };
    expect(allData.testsNotRun).toEqual([]);
    expect(["complete", "advisory_inspect"]).toContain(allData.completionAuthority);
  });

  it("completes coverage for a planned tracked deletion without inventing a focus file", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const deletedFile = files[0]!;
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "planned-tracked-deletion");
    await unlink(path.join(repo, deletedFile));

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "planned-tracked-deletion",
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; omittedTargetCount: number };
      unindexedEditedFiles: string[];
      context: { focusFiles: Array<{ file: { path: string } }> };
    };
    expect(data.reviewTargets).toEqual([deletedFile]);
    expect(data.reviewCoverage).toMatchObject({ status: "complete", omittedTargetCount: 0 });
    expect(data.unindexedEditedFiles).not.toContain(deletedFile);
    expect(data.context.focusFiles.map((entry) => entry.file.path)).not.toContain(deletedFile);
    expect(data.inspectReasons).not.toContain("source-like edited files are not indexed");
    expect(data.completionAuthority).not.toBe("blocking_inspect");
  });

  it("uses exact dirty authority for advisory unindexed files without hiding indexed source targets", async () => {
    const { repo, files } = await createManyFileRepo(1);
    const sourceFile = files[0]!;
    const lockFile = "package-lock.json";
    await addTrackedFile(repo, lockFile, '{"lockfileVersion":3}\n');
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, lockFile), '{"lockfileVersion":3,"packages":{}}\n', "utf8");
    await writeFile(path.join(repo, sourceFile), "export const value0 = 100;\n", "utf8");

    const review = await postEditReviewQuery(
      repo,
      {
        task: "Review the lockfile and source edit",
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; omittedTargetCount: number };
      unindexedEditedFiles: string[];
      context: { focusFiles: Array<{ file: { path: string } }> };
    };
    expect(data.reviewCandidateTargets).toEqual([lockFile, sourceFile]);
    expect(data.reviewTargets).toEqual([lockFile, sourceFile]);
    expect(data.reviewCoverage).toMatchObject({ status: "complete", omittedTargetCount: 0 });
    expect(data.unindexedEditedFiles).toContain(lockFile);
    expect(data.context.focusFiles.map((entry) => entry.file.path)).toContain(sourceFile);
    expect(data.context.focusFiles.map((entry) => entry.file.path)).not.toContain(lockFile);
    expect(data.inspectReasons).not.toContain("source-like edited files are not indexed");
    expect(data.completionAuthority).not.toBe("blocking_inspect");
  });

  it("keeps present unindexed source-like edits blocking after exact coverage succeeds", async () => {
    const { repo } = await createManyFileRepo(1);
    const unindexedSource = "src/opaque.foo";
    await addTrackedFile(repo, unindexedSource, "value = 1\n");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, unindexedSource), "value = 2\n", "utf8");

    const review = await postEditReviewQuery(
      repo,
      {
        task: "Review the opaque source edit",
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      inspectReasons: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; omittedTargetCount: number };
      unindexedEditedFiles: string[];
      context: { focusFiles: Array<{ file: { path: string } }> };
    };
    expect(data.reviewTargets).toEqual([unindexedSource]);
    expect(data.reviewCoverage).toMatchObject({ status: "complete", omittedTargetCount: 0 });
    expect(data.unindexedEditedFiles).toContain(unindexedSource);
    expect(data.context.focusFiles.map((entry) => entry.file.path)).not.toContain(unindexedSource);
    expect(data.inspectReasons).toContain("source-like edited files are not indexed");
    expect(data.completionAuthority).toBe("blocking_inspect");
  });

  it("stops coverage at the first unresolved explicit target", async () => {
    const { repo } = await createManyFileRepo(1);
    await buildIndex({ repoRoot: repo });

    const review = await postEditReviewQuery(
      repo,
      {
        task: "Review a missing explicit target",
        files: ["src/missing.ts"],
        persistOutcome: false
      },
      { autoRefresh: false }
    );
    const data = review.data as {
      completionAuthority: string;
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: { status: string; analyzedTargetCount: number; omittedTargetCount: number };
    };
    expect(data.reviewCandidateTargets).toEqual(["src/missing.ts"]);
    expect(data.reviewTargets).toEqual([]);
    expect(data.reviewCoverage).toMatchObject({ status: "partial", analyzedTargetCount: 0, omittedTargetCount: 1 });
    expect(["blocking_inspect", "replan_required"]).toContain(data.completionAuthority);
  });

  it("retains prior-pass evidence when a later explicit target is unresolved", async () => {
    const { repo, files } = await createManyFileRepo(3);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "later-unresolved-target");
    await editFiles(repo, files);

    const review = await postEditReviewQuery(
      repo,
      {
        taskId: "later-unresolved-target",
        files: ["src/missing.ts"],
        limit: 3,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"],
        persistOutcome: false
      },
      { autoRefresh: true }
    );
    const data = review.data as {
      completionAuthority: string;
      reviewCandidateTargets: string[];
      reviewTargets: string[];
      reviewCoverage: {
        status: string;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        analysisPassCount: number;
      };
    };
    expect(data.reviewCandidateTargets).toEqual([...files, "src/missing.ts"]);
    expect(data.reviewTargets).toEqual(files);
    expect(data.reviewCoverage).toMatchObject({
      status: "partial",
      analyzedTargetCount: 3,
      omittedTargetCount: 1,
      analysisPassCount: 1
    });
    expect(data.completionAuthority).toBe("blocking_inspect");
  });

  it("classifies valid partial and malformed complete coverage as blocking", () => {
    type DecisionInput = Parameters<typeof postEditDecision>[0];
    const base: DecisionInput = {
      snapshot: { taskId: "coverage-decision" } as NonNullable<DecisionInput["snapshot"]>,
      loadedSnapshot: {},
      snapshotAmbiguity: undefined,
      worktreeDegradationReasons: [],
      headChanged: false,
      unplannedEditedFiles: [],
      unplannedChangedSymbols: [],
      unindexedEditedFiles: [],
      symbolDeltas: [],
      riskDeltas: [],
      workflowChecks: [],
      dependencyChecks: [],
      degradedSnapshotTests: [],
      quality: undefined,
      riskEscalations: [],
      waivedVerification: [],
      hasActualEditedFiles: true,
      testsNotRun: [],
      hasTestVerificationAccounting: true,
      noVerificationProofForEditedFiles: false,
      reviewCoverageContext: {
        taskId: "coverage-decision",
        planRevision: 1,
        snapshotCreatedAt: null,
        snapshotPublicationSequence: null,
        candidateTargets: Array.from({ length: 11 }, (_, index) => `src/${index}.ts`),
        analyzedTargets: Array.from({ length: 10 }, (_, index) => `src/${index}.ts`)
      },
      implicitBaseline: false
    };
    const partialCoverage = createPostEditReviewCoverage({
      ...base.reviewCoverageContext,
      candidateTargets: base.reviewCoverageContext.candidateTargets!,
      targetLimit: 10
    });
    const partial = postEditDecision({
      ...base,
      reviewCoverage: partialCoverage
    });
    expect(partial).toMatchObject({
      verdict: "inspect",
      inspectMode: "blocking",
      completionAuthority: "blocking_inspect"
    });

    const malformed = postEditDecision({
      ...base,
      reviewCoverage: {
        ...partialCoverage,
        status: "complete"
      }
    });
    expect(malformed).toMatchObject({
      verdict: "inspect",
      inspectMode: "blocking",
      completionAuthority: "blocking_inspect",
      reviewCoverageBlockReason: expect.stringContaining("invalid")
    });

    const candidateTargets = ["src/a.ts", "src/b.ts", "src/omitted.ts"];
    const analyzedTargets = ["src/a.ts", "src/b.ts", "src/unrelated.ts"];
    const substituted = postEditDecision({
      ...base,
      reviewCoverageContext: {
        ...base.reviewCoverageContext,
        candidateTargets,
        analyzedTargets
      },
      reviewCoverage: {
        schemaVersion: 2,
        binding: {
          taskId: "coverage-decision",
          planRevision: 1,
          snapshotCreatedAt: null,
          snapshotPublicationSequence: null,
          candidateTargetsDigest: postEditReviewTargetDigest(candidateTargets),
          analyzedTargetsDigest: postEditReviewTargetDigest(analyzedTargets)
        },
        status: "complete",
        candidateTargetCount: 3,
        analyzedTargetCount: 3,
        omittedTargetCount: 0,
        targetLimit: 3,
        analysisPassCount: 1
      }
    });
    expect(substituted).toMatchObject({
      verdict: "inspect",
      inspectMode: "blocking",
      completionAuthority: "blocking_inspect",
      reviewCoverageBlockReason: expect.stringContaining("candidate prefix")
    });
  });
});

async function createManyFileRepo(count: number): Promise<{ repo: string; files: string[] }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-review-coverage-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  const files = Array.from({ length: count }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`);
  for (const [index, file] of files.entries()) {
    await writeFile(path.join(repo, file), `export const value${index} = ${index};\n`, "utf8");
  }
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }, null, 2)}\n`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return { repo, files };
}

async function createManyTestRepo(count: number): Promise<{ repo: string; sourceFile: string; testFiles: string[] }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-test-authority-"));
  const sourceFile = "src/shared.ts";
  const testFiles = Array.from({ length: count }, (_, index) => `tests/shared-${String(index).padStart(2, "0")}.test.ts`);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, sourceFile), "export const value = 1;\n", "utf8");
  for (const [index, testFile] of testFiles.entries()) {
    await writeFile(
      path.join(repo, testFile),
      `import { value } from "../src/shared.js";\nexport const observed${index} = value;\n`,
      "utf8"
    );
  }
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ scripts: { test: "vitest run" } }, null, 2)}\n`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return { repo, sourceFile, testFiles };
}

async function addStaticRisk(repo: string, file: string): Promise<void> {
  await mkdir(path.join(repo, "reports/static-analysis"), { recursive: true });
  await writeFile(
    path.join(repo, "reports/static-analysis/risks.json"),
    JSON.stringify({
      risks: [
        {
          path: file,
          signal: "late-batch-risk",
          reason: "proves a later bounded pass contributes to the decision",
          score: 9
        }
      ]
    }),
    "utf8"
  );
  execFileSync("git", ["add", "reports/static-analysis/risks.json"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "test: add late batch risk"],
    { cwd: repo, stdio: "ignore" }
  );
}

async function addImportHub(repo: string, files: string[]): Promise<void> {
  const imports = files
    .map((file, index) => `import { value${index} } from "./${path.posix.basename(file, ".ts")}.js";`)
    .join("\n");
  const values = files.map((_file, index) => `value${index}`).join(" + ");
  await writeFile(path.join(repo, "src/hub.ts"), `${imports}\nexport const total = ${values};\n`, "utf8");
  execFileSync("git", ["add", "src/hub.ts"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "test: add import hub"],
    { cwd: repo, stdio: "ignore" }
  );
}

async function addTrackedFile(repo: string, file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), contents, "utf8");
  execFileSync("git", ["add", file], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", `test: add ${file}`],
    { cwd: repo, stdio: "ignore" }
  );
}

async function saveManyFilePlan(repo: string, files: string[], taskId: string): Promise<void> {
  await changePlanQuery(
    repo,
    {
      task: "Change every explicitly listed source file",
      files,
      diff: false,
      limit: 30,
      saveSnapshot: true,
      taskId
    },
    { autoRefresh: false }
  );
}

async function editFiles(repo: string, files: string[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    await writeFile(path.join(repo, file), `export const value${index} = ${index + 100};\n`, "utf8");
  }
}
