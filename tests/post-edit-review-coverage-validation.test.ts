import { describe, expect, it } from "vitest";
import { compactMcpResult } from "../src/mcp/compaction.js";
import { mcpDecisionKernel } from "../src/mcp/decision-kernel.js";
import {
  createPostEditReviewCoverage,
  isCompletionBearingPostEditReviewCoverage,
  postEditReviewTargetDigest,
  validatePostEditReviewCoverage
} from "../src/post-edit-review-coverage.js";
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
  it("accepts generated complete and partial receipts", () => {
    const partial = createPostEditReviewCoverage({ ...context, targetLimit: 3 });
    expect(validatePostEditReviewCoverage(partial, context)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(partial, context)).toBe(false);

    const completeContext = { ...context, candidateTargets: context.analyzedTargets };
    const complete = createPostEditReviewCoverage({ ...completeContext, targetLimit: 3 });
    expect(validatePostEditReviewCoverage(complete, completeContext)).toMatchObject({ valid: true });
    expect(isCompletionBearingPostEditReviewCoverage(complete, completeContext)).toBe(true);
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
      schemaVersion: 1,
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
      targetLimit: 3
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
