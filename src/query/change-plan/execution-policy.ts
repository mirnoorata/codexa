import { effectiveAutonomyMode } from "../../autonomy.js";
import type { ChangePlanAutoVerifyData } from "../../types.js";
import { shellQuote } from "../verification/shell.js";

export async function buildChangePlanExecutionPolicy(
  repoRoot: string,
  editable: boolean
): Promise<{ completionReview: boolean; autoVerify: ChangePlanAutoVerifyData; autoVerifySummary: string }> {
  // Only a true completion/Stop host hook may own final review. Edit-scoped
  // PostToolUse hooks run before later verification and do not qualify.
  const completionReview = editable && process.env.CODEXA_MANAGED_POST_EDIT === "1";
  const autonomy = await effectiveAutonomyMode(repoRoot);
  const autoVerify: ChangePlanAutoVerifyData = {
    enabled: autonomy.mode === "full-access",
    mode: autonomy.mode,
    source: autonomy.source,
    trustBoundary: "hook-post-edit-only",
    enableCommand: autonomy.mode === "full-access" ? undefined : `codexa autonomy ${shellQuote(repoRoot)} --mode full-access`
  };
  const autoVerifySummary = autoVerify.enabled
    ? `AutoVerify: enabled (${autoVerify.mode} via ${autoVerify.source}); trusted execution remains hook-post-edit only.`
    : `AutoVerify: off (${autoVerify.mode} via ${autoVerify.source}); optional user opt-in: ${autoVerify.enableCommand}`;
  return { completionReview, autoVerify, autoVerifySummary };
}
