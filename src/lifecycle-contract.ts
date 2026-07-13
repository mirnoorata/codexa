import { z } from "zod";
import type { TaskInvariantReview } from "./types.js";

export const MAX_TASK_INVARIANTS = 12;
export const MAX_TASK_INVARIANT_CHARS = 280;
export const MAX_TASK_INVARIANT_REVIEWS = 12;
export const MAX_TASK_INVARIANT_EVIDENCE = 8;
export const MAX_VERIFICATION_ARTIFACT_IDS = 20;

export const taskInvariantStatementSchema = z.string().trim().min(1).max(MAX_TASK_INVARIANT_CHARS);

export const taskInvariantReviewSchema: z.ZodType<TaskInvariantReview> = z
  .object({
    invariantId: z.string().trim().min(1).max(160),
    status: z.enum(["satisfied", "violated"]),
    evidence: z.array(z.string().trim().min(1).max(MAX_TASK_INVARIANT_CHARS)).max(MAX_TASK_INVARIANT_EVIDENCE)
  })
  .strict();

export const verificationArtifactIdSchema = z.string().trim().regex(/^va_[a-f0-9]{64}$/u);

export function validateInvariantStatements(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  if (values.length > MAX_TASK_INVARIANTS) {
    throw new Error(`At most ${MAX_TASK_INVARIANTS} task invariants may be supplied`);
  }
  return values.map((value) => taskInvariantStatementSchema.parse(value));
}

export function parseInvariantReviewJsonOptions(values: string[] | undefined): TaskInvariantReview[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  if (values.length > MAX_TASK_INVARIANT_REVIEWS) {
    throw new Error(`At most ${MAX_TASK_INVARIANT_REVIEWS} invariant reviews may be supplied`);
  }
  return values.map((value, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invariant review ${index + 1} is not valid JSON`);
    }
    const result = taskInvariantReviewSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`Invariant review ${index + 1} is invalid${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`);
    }
    return result.data;
  });
}

export function validateArtifactIds(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  if (values.length > MAX_VERIFICATION_ARTIFACT_IDS) {
    throw new Error(`At most ${MAX_VERIFICATION_ARTIFACT_IDS} verification artifact IDs may be supplied`);
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const artifactId = verificationArtifactIdSchema.parse(value);
    if (!seen.has(artifactId)) {
      seen.add(artifactId);
      unique.push(artifactId);
    }
  }
  return unique;
}
