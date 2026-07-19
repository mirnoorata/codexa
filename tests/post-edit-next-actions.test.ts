import { describe, expect, it } from "vitest";
import { postEditStructuredNextTools } from "../src/query/post-edit/next-actions.js";

describe("post-edit structured next actions", () => {
  it("declares saved replans as writeful task and lifecycle operations", () => {
    const [replan] = postEditStructuredNextTools("replan", {
      taskId: "task-1",
      reviewScope: ["src/app.ts"],
      changeType: "behavior",
      testsNotRun: [],
      degradedSnapshotTests: [],
      riskEscalationsNeedInspection: false,
      riskEscalations: []
    });

    expect(replan).toMatchObject({
      tool: "change_plan",
      requiredInputs: { taskId: "task-1", files: ["src/app.ts"], saveSnapshot: true },
      readOnly: false,
      writes: [".codex/cache/codexa-tasks", ".codex/cache/codexa-task-lifecycle"]
    });
  });
});
