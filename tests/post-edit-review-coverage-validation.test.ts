import { describe, expect, it } from "vitest";
import { compactMcpResult } from "../src/mcp/compaction.js";
import { mcpDecisionKernel } from "../src/mcp/decision-kernel.js";
import {
  MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS,
  createPostEditReviewCoverage,
  isCompletionBearingPostEditReviewCoverage,
  postEditReviewTargetDigest,
  validatePostEditReviewCoverage
} from "../src/post-edit-review-coverage.js";
import { postEditReviewPasses } from "../src/query/post-edit/context-passes.js";
import type { QueryResult } from "../src/types.js";

const context = {
  taskId: "coverage-validation",
  planRevision: 2,
  snapshotCreatedAt: "2026-07-25T00:00:00.000Z",
  snapshotPublicationSequence: 4,
  candidateTargets: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
  analyzedTargets: ["src/a.ts", "src/b.ts", "src/c.ts"]
};

describe("post-edit review coverage validation", () => {
  it("uses the task-lifecycle candidate boundary without a hidden pass-count cap", () => {
    const maximumTargets = Array.from(
      { length: MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS },
      (_, index) => `src/file-${index}.ts`
    );
    const passes = postEditReviewPasses(maximumTargets, 30);
    expect(passes).toHaveLength(67);
    expect(passes.flat()).toEqual(maximumTargets);
    expect(() => postEditReviewPasses([...maximumTargets, "src/overflow.ts"], 30)).toThrow(
      `${MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS}-target lifecycle safety limit`
    );
    expect(() =>
      createPostEditReviewCoverage({
        ...context,
        candidateTargets: [...maximumTargets, "src/overflow.ts"],
        analyzedTargets: [...maximumTargets, "src/overflow.ts"],
        targetLimit: 30
      })
    ).toThrow(`${MAX_POST_EDIT_REVIEW_CANDIDATE_TARGETS}-target lifecycle safety limit`);
  });

  it("accepts generated complete and partial receipts", () => {
    const partial = createPostEditReviewCoverage({ ...context, targetLimit: 3 });
    expect(validatePostEditReviewCoverage(partial, context)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(partial, context)).toBe(false);

    const completeContext = { ...context, candidateTargets: context.analyzedTargets };
    const complete = createPostEditReviewCoverage({ ...completeContext, targetLimit: 3 });
    expect(validatePostEditReviewCoverage(complete, completeContext)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(complete, completeContext)).toBe(true);

    const { analysisPassCount: _analysisPassCount, ...legacyComplete } = complete;
    const legacyV1 = { ...legacyComplete, schemaVersion: 1 as const };
    expect(validatePostEditReviewCoverage(legacyV1, completeContext)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(legacyV1, completeContext)).toBe(true);
  });

  it("binds exhaustive broad reviews to the exact number of maximum-size analysis passes", () => {
    const candidateTargets = Array.from({ length: 61 }, (_, index) => `src/file-${index}.ts`);
    const broadContext = {
      ...context,
      candidateTargets,
      analyzedTargets: candidateTargets
    };
    const complete = createPostEditReviewCoverage({
      ...broadContext,
      targetLimit: 30,
      analysisPassCount: 3
    });
    expect(complete).toMatchObject({
      status: "complete",
      candidateTargetCount: 61,
      analyzedTargetCount: 61,
      omittedTargetCount: 0,
      targetLimit: 30,
      analysisPassCount: 3
    });
    expect(validatePostEditReviewCoverage(complete, broadContext)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(complete, broadContext)).toBe(true);

    expect(validatePostEditReviewCoverage({ ...complete, analysisPassCount: 1 }, broadContext)).toMatchObject({
      valid: false,
      reason: "analysisPassCount does not match analyzed targets"
    });
    expect(validatePostEditReviewCoverage({ ...complete, analysisPassCount: 4 }, broadContext)).toMatchObject({
      valid: false,
      reason: "analysisPassCount does not match analyzed targets"
    });
    expect(validatePostEditReviewCoverage({ ...complete, targetLimit: 10, analysisPassCount: 7 }, broadContext)).toMatchObject({
      valid: true
    });
  });

  it("validates the full broad target list before compact MCP delivery returns only 30 targets", () => {
    const targets = Array.from({ length: 61 }, (_, index) => `src/file-${index}.ts`);
    const broadContext = {
      ...context,
      candidateTargets: targets,
      analyzedTargets: targets
    };
    const reviewCoverage = createPostEditReviewCoverage({
      ...broadContext,
      targetLimit: 10,
      analysisPassCount: 7
    });
    const data: Record<string, unknown> = {
      mode: "post_edit_review",
      taskId: context.taskId,
      planRevision: context.planRevision,
      snapshot: {
        taskId: context.taskId,
        planRevision: context.planRevision,
        createdAt: context.snapshotCreatedAt,
        publicationSequence: context.snapshotPublicationSequence
      },
      reviewCandidateTargets: targets,
      reviewTargets: targets,
      reviewCoverage,
      actionability: "done",
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    };

    expect(validatePostEditReviewCoverage(reviewCoverage, broadContext)).toMatchObject({ valid: true });
    expect(mcpDecisionKernel(data).authority).toMatchObject({
      actionability: "done",
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    });

    const compacted = compactMcpResult({ text: "complete", data } as QueryResult, { format: "concise" });
    const compactedData = compacted.data as Record<string, unknown>;
    expect(compactedData.reviewCandidateTargets).toBeUndefined();
    expect(compactedData.reviewTargets).toEqual(targets.slice(0, 30));
    expect(compactedData.truncation).toMatchObject({
      reviewTargets: { total: 61, returned: 30 }
    });
    expect(compactedData.decisionKernel).toMatchObject({
      authority: {
        actionability: "done",
        verdict: "continue",
        completionAuthority: "complete",
        inspectMode: "none"
      }
    });
  });

  it.each([
    ["missing", undefined],
    ["impossible complete counts", {
      ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }),
      status: "complete"
    }],
    ["analyzed beyond limit", {
      ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }),
      status: "complete",
      candidateTargetCount: 31,
      analyzedTargetCount: 31,
      omittedTargetCount: 0
    }],
    ["partial without omission", {
      ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }),
      candidateTargetCount: 3,
      omittedTargetCount: 0
    }],
    ["wrong binding", {
      ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }),
      binding: {
        ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }).binding,
        analyzedTargetsDigest: "0000000000000000"
      }
    }]
  ])("rejects %s", (_label, receipt) => {
    expect(validatePostEditReviewCoverage(receipt, context).valid).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["malformed complete", {
      ...createPostEditReviewCoverage({ ...context, targetLimit: 3 }),
      status: "complete"
    }]
  ])("downgrades every compact completion surface for %s coverage", (_label, reviewCoverage) => {
    const data: Record<string, unknown> = {
      mode: "post_edit_review",
      taskId: context.taskId,
      planRevision: context.planRevision,
      snapshot: {
        taskId: context.taskId,
        createdAt: context.snapshotCreatedAt,
        publicationSequence: context.snapshotPublicationSequence
      },
      reviewCandidateTargets: context.candidateTargets,
      reviewTargets: context.analyzedTargets,
      reviewCoverage,
      actionability: "done",
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    };
    const kernel = mcpDecisionKernel(data);
    expect(kernel.authority).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking"
    });
    const compacted = compactMcpResult({ text: "unsafe", data } as QueryResult, { format: "concise" });
    expect(compacted.data).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking",
      decisionKernel: {
        authority: {
          actionability: "blocked",
          verdict: "inspect",
          completionAuthority: "blocking_inspect",
          inspectMode: "blocking"
        }
      }
    });
  });

  it("rejects contradictory top-level and snapshot bindings before compact authority is built", () => {
    const receipt = createPostEditReviewCoverage({
      ...context,
      taskId: "other-task",
      candidateTargets: context.analyzedTargets,
      targetLimit: 3
    });
    const kernel = mcpDecisionKernel({
      mode: "post_edit_review",
      taskId: "other-task",
      planRevision: context.planRevision,
      snapshot: {
        taskId: context.taskId,
        planRevision: context.planRevision,
        createdAt: context.snapshotCreatedAt,
        publicationSequence: context.snapshotPublicationSequence
      },
      reviewCandidateTargets: context.analyzedTargets,
      reviewTargets: context.analyzedTargets,
      reviewCoverage: receipt,
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    });
    expect(kernel.authority).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect"
    });
  });

  it("cannot launder partial coverage by rewriting counts and the candidate digest", () => {
    const partial = createPostEditReviewCoverage({ ...context, targetLimit: 3 });
    const laundered = {
      ...partial,
      status: "complete",
      candidateTargetCount: context.analyzedTargets.length,
      analyzedTargetCount: context.analyzedTargets.length,
      omittedTargetCount: 0,
      binding: {
        ...partial.binding,
        candidateTargetsDigest: partial.binding.analyzedTargetsDigest
      }
    };
    const data: Record<string, unknown> = {
      mode: "post_edit_review",
      taskId: context.taskId,
      planRevision: context.planRevision,
      snapshot: {
        taskId: context.taskId,
        planRevision: context.planRevision,
        createdAt: context.snapshotCreatedAt,
        publicationSequence: context.snapshotPublicationSequence
      },
      reviewCandidateTargets: context.candidateTargets,
      reviewTargets: context.analyzedTargets,
      reviewCoverage: laundered,
      actionability: "done",
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    };

    expect(validatePostEditReviewCoverage(laundered, context).valid).toBe(false);
    expect(mcpDecisionKernel(data).authority).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking"
    });

    const compacted = compactMcpResult({ text: "unsafe", data } as QueryResult, { format: "concise" });
    expect((compacted.data as Record<string, unknown>).reviewCandidateTargets).toBeUndefined();
    expect(compacted.data).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking"
    });
  });

  it("cannot substitute an unrelated analyzed target for an omitted candidate", () => {
    const candidateTargets = ["src/a.ts", "src/b.ts", "src/omitted.ts"];
    const analyzedTargets = ["src/a.ts", "src/b.ts", "src/unrelated.ts"];
    const substitutionContext = {
      ...context,
      candidateTargets,
      analyzedTargets
    };
    const substituted = {
      schemaVersion: 2,
      binding: {
        taskId: context.taskId,
        planRevision: context.planRevision,
        snapshotCreatedAt: context.snapshotCreatedAt,
        snapshotPublicationSequence: context.snapshotPublicationSequence,
        candidateTargetsDigest: postEditReviewTargetDigest(candidateTargets),
        analyzedTargetsDigest: postEditReviewTargetDigest(analyzedTargets)
      },
      status: "complete",
      candidateTargetCount: candidateTargets.length,
      analyzedTargetCount: analyzedTargets.length,
      omittedTargetCount: 0,
      targetLimit: 3,
      analysisPassCount: 1
    };
    const data: Record<string, unknown> = {
      mode: "post_edit_review",
      taskId: context.taskId,
      planRevision: context.planRevision,
      snapshot: {
        taskId: context.taskId,
        planRevision: context.planRevision,
        createdAt: context.snapshotCreatedAt,
        publicationSequence: context.snapshotPublicationSequence
      },
      reviewCandidateTargets: candidateTargets,
      reviewTargets: analyzedTargets,
      reviewCoverage: substituted,
      actionability: "done",
      verdict: "continue",
      completionAuthority: "complete",
      inspectMode: "none"
    };

    expect(validatePostEditReviewCoverage(substituted, substitutionContext)).toMatchObject({
      valid: false,
      reason: "analyzed targets do not match the candidate prefix"
    });
    expect(isCompletionBearingPostEditReviewCoverage(substituted, substitutionContext)).toBe(false);
    expect(mcpDecisionKernel(data).authority).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking"
    });

    const compacted = compactMcpResult({ text: "unsafe", data } as QueryResult, { format: "concise" });
    expect((compacted.data as Record<string, unknown>).reviewCandidateTargets).toBeUndefined();
    expect(compacted.data).toMatchObject({
      actionability: "blocked",
      verdict: "inspect",
      completionAuthority: "blocking_inspect",
      inspectMode: "blocking",
      decisionKernel: {
        authority: {
          actionability: "blocked",
          verdict: "inspect",
          completionAuthority: "blocking_inspect",
          inspectMode: "blocking"
        }
      }
    });
  });
});
