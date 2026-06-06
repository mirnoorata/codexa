import type { PostEditCheckResult, PostEditVerdict } from "../../post-edit-outcomes.js";
import type { ChangeType, FileFact, TaskSnapshot, TestRecommendation, WorkflowTraceFact } from "../../types.js";
import { nextTool } from "../next-tools.js";

export function postEditNextActions(
  verdict: PostEditVerdict,
  input: {
    snapshot?: TaskSnapshot;
    unplannedEditedFiles: string[];
    testsNotRun: TestRecommendation[];
    degradedSnapshotTests: TestRecommendation[];
    riskEscalations: FileFact[];
    reviewTargets: string[];
    workflows: WorkflowTraceFact[];
    missingChecks: PostEditCheckResult[];
    noVerificationProofForEditedFiles: boolean;
  }
): string[] {
  if (verdict === "replan") {
    return [
      "Call change_plan again with saveSnapshot=true before making more edits.",
      input.unplannedEditedFiles.length > 0 ? `Inspect unplanned edits first: ${input.unplannedEditedFiles.slice(0, 6).join(", ")}` : "Inspect the low-quality or stale evidence before continuing.",
      input.testsNotRun.length > 0 ? `Run or justify the top targeted tests: ${input.testsNotRun.slice(0, 4).map((test) => test.path).join(", ")}` : "Rebuild a narrow test plan after re-planning."
    ];
  }
  if (verdict === "inspect") {
    return [
      input.degradedSnapshotTests.length > 0
        ? "Re-run change_plan for the current edit scope before treating planned-test evidence as trusted."
        : input.snapshot
          ? "Read the unplanned or high-risk files before treating the edit as complete."
          : "No saved task snapshot was available; treat this as a dirty-diff review, not a drift proof.",
      input.riskEscalations.length > 0 ? `Check risk targets: ${input.riskEscalations.slice(0, 5).map((file) => file.path).join(", ")}` : `Check review targets: ${input.reviewTargets.slice(0, 6).join(", ") || "none"}`,
      input.missingChecks.length > 0 ? `Resolve required checks: ${input.missingChecks.slice(0, 4).map((check) => check.target).join(", ")}` : "Required snapshot checks are covered.",
      input.testsNotRun.length > 0
        ? `Run or explicitly account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}`
        : input.noVerificationProofForEditedFiles
          ? "Report a relevant test, build, or typecheck command before treating edited files as verified."
          : "Targeted tests are accounted for.",
      input.workflows.length > 0 ? `Call workflow_path for ${input.workflows[0].title} if behavior changed.` : "Call callers or dependency_path if the touched file changes a public contract."
    ];
  }
  if (verdict === "run_tests") {
    return [
      `Run or account for: ${input.testsNotRun.slice(0, 6).map((test) => test.path).join(", ")}`,
      "After checks pass, call post_edit_review again with ranCommands for commands you ran, or ranTests only for direct file/test accounting."
    ];
  }
  return ["No drift detected against the saved snapshot. Finish with the normal source diff review and targeted tests already reported."];
}

export function postEditStructuredNextTools(
  verdict: PostEditVerdict,
  input: {
    reviewScope: string[];
    changeType: ChangeType;
    testsNotRun: TestRecommendation[];
    degradedSnapshotTests: TestRecommendation[];
    riskEscalationsNeedInspection: boolean;
    riskEscalations: FileFact[];
  }
): Array<ReturnType<typeof nextTool>> {
  return [
    verdict === "run_tests" && input.testsNotRun[0] ? nextTool("test_plan", "recommended tests remain unaccounted for", { files: input.reviewScope.slice(0, 8), diff: true }) : undefined,
    verdict === "replan" || input.degradedSnapshotTests.length > 0
      ? nextTool(
          "change_plan",
          input.degradedSnapshotTests.length > 0 ? "planned-test provenance degraded; rebuild the plan for the current edit scope" : "saved plan drifted from the current edit scope",
          { files: input.reviewScope.slice(0, 8), saveSnapshot: true, changeType: input.changeType },
          true,
          [".codex/cache/codexa-task-snapshots"]
        )
      : undefined,
    input.riskEscalationsNeedInspection ? nextTool("impact", "high-risk or unplanned target needs relationship inspection", { file: input.riskEscalations[0]?.path }) : undefined
  ].filter((tool): tool is ReturnType<typeof nextTool> => Boolean(tool));
}
