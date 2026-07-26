import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { latestCompletedPostEditReviewMatches } from "../src/post-edit-outcomes.js";
import { createPostEditReviewCoverage, postEditReviewTargetDigest } from "../src/post-edit-review-coverage.js";
import { proveQuery } from "../src/prove.js";
import { postEditDecision } from "../src/query/post-edit/decision.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";

describe("post-edit review target coverage", () => {
  it("blocks completion when the target limit omits changed files and persists the bounded receipt", async () => {
    const { repo, files } = await createManyFileRepo(11);
    await buildIndex({ repoRoot: repo });
    await saveManyFilePlan(repo, files, "partial-review-coverage");
    await editFiles(repo, files);

    const partial = await postEditReviewQuery(
      repo,
      {
        taskId: "partial-review-coverage",
        limit: 10,
        tokenBudget: 10_000,
        ranCommands: ["npm run typecheck"]
      },
      { autoRefresh: true }
    );
    const data = partial.data as {
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
        schemaVersion: number;
        binding: { taskId: string; planRevision: number; candidateTargetsDigest: string; analyzedTargetsDigest: string };
      };
      outcome: { persisted: boolean; reviewCoverage: { status: string; omittedTargetCount: number } };
      failureSignals: Array<{ class: string; targets: string[] }>;
    };

    expect(data.reviewCandidateTargets).toHaveLength(11);
    expect(data.reviewTargets).toHaveLength(10);
    expect(data.reviewCoverage).toMatchObject({
      schemaVersion: 1,
      status: "partial",
      candidateTargetCount: 11,
      analyzedTargetCount: 10,
      omittedTargetCount: 1,
      targetLimit: 10,
      binding: { taskId: "partial-review-coverage", planRevision: 1 }
    });
    expect(data.reviewCoverage.binding.candidateTargetsDigest).toMatch(/^[a-f0-9]{16}$/u);
    expect(data.reviewCoverage.binding.analyzedTargetsDigest).toMatch(/^[a-f0-9]{16}$/u);
    expect(data.verdict).toBe("inspect");
    expect(data.inspectMode).toBe("blocking");
    expect(data.completionAuthority).toBe("blocking_inspect");
    expect(data.inspectReasons).toContain("1 candidate review target(s) were not analyzed");
    expect(data.outcome).toMatchObject({
      persisted: true,
      reviewCoverage: { status: "partial", omittedTargetCount: 1 }
    });
    expect(data.failureSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: "verification-missing",
          targets: ["post-edit-review-scope:1-target(s)-omitted"]
        })
      ])
    );
    expect(partial.text).toContain("Review scope: partial (10/11");
    expect(partial.text).toContain("Raise limit to widen the review");
    const partialProof = await proveQuery(repo, {
      taskId: "partial-review-coverage",
      autoRefresh: false
    });
    expect(
      (partialProof.data as { gaps: string[] }).gaps
    ).toContain("latest post-edit review is unresolved: 1-target(s)-omitted");

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
        schemaVersion: 1;
        binding: Record<string, unknown>;
        status: string;
        candidateTargetCount: number;
        analyzedTargetCount: number;
        omittedTargetCount: number;
        targetLimit: number;
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
      schemaVersion: 1,
      status: "complete",
      candidateTargetCount: 11,
      analyzedTargetCount: 11,
      omittedTargetCount: 0,
      targetLimit: 30
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
    const legacyOutcome = JSON.parse(await readFile(completeOutcomePath, "utf8"));
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

  it("stays blocking at the maximum limit and recommends splitting instead of an impossible larger limit", async () => {
    const { repo, files } = await createManyFileRepo(31);
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
      reviewCoverage: { status: string; omittedTargetCount: number; targetLimit: number };
      nextActions: string[];
    };
    expect(data.reviewCoverage).toMatchObject({ status: "partial", omittedTargetCount: 1, targetLimit: 30 });
    expect(data.completionAuthority).toBe("blocking_inspect");
    expect(data.nextActions[0]).toContain("Narrow or split");
    expect(review.text).toContain("Narrow or split the review");
    expect(review.text).not.toContain("Raise limit to widen");
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
        schemaVersion: 1,
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
        targetLimit: 3
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
