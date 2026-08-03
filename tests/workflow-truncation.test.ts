import { describe, expect, it } from "vitest";
import { compactWorkflow } from "../src/mcp/compaction-helpers.js";
import { compactWorkflowTrace } from "../src/query/compact-data.js";
import { formatWorkflow } from "../src/query/workflow.js";
import type { WorkflowTraceFact } from "../src/types.js";

describe("workflow truncation receipts", () => {
  it("preserves upstream bounds through query and MCP projections and renders them", () => {
    const workflow = workflowFixture();

    const queryWorkflow = compactWorkflowTrace(workflow);
    expect(queryWorkflow.steps).toHaveLength(16);
    expect(queryWorkflow.relatedFiles).toHaveLength(40);
    expect(queryWorkflow.tests).toHaveLength(20);
    expect(queryWorkflow.truncation).toEqual({
      steps: { total: 22, returned: 16 },
      relatedFiles: { total: 50, returned: 40 },
      tests: { total: 25, returned: 20 },
      executionSurfaces: { total: 70, returned: 64 }
    });

    const text = formatWorkflow(queryWorkflow as WorkflowTraceFact).join("\n");
    expect(text).toContain("... 10 more steps");
    expect(text).toContain("tests: tests/workflow-0.test.ts");
    expect(text).toContain("(+19 more)");
    expect(text).toContain("evidence bounds: steps 16/22 retained; related files 40/50 retained; tests 20/25 retained; execution surfaces 64/70 retained");

    const mcpWorkflow = compactWorkflow(queryWorkflow) as {
      relatedFiles: unknown[];
      tests: unknown[];
      steps: unknown[];
      truncation: Record<string, { total: number; returned: number }>;
    };
    expect(mcpWorkflow.relatedFiles).toHaveLength(20);
    expect(mcpWorkflow.tests).toHaveLength(20);
    expect(mcpWorkflow.steps).toHaveLength(16);
    expect(mcpWorkflow.truncation).toEqual({
      relatedFiles: { total: 50, returned: 20 },
      tests: { total: 25, returned: 20 },
      steps: { total: 22, returned: 16 },
      executionSurfaces: { total: 70, returned: 64 }
    });
  });
});

function workflowFixture(): WorkflowTraceFact {
  return {
    id: "workflow:test",
    type: "WorkflowTrace",
    source: "heuristic",
    confidence: "derived",
    snapshotId: "snapshot:test",
    indexedAt: "2026-08-03T00:00:00.000Z",
    workflowKind: "route",
    title: "Bounded route",
    entryPath: "src/route.ts",
    relatedFiles: Array.from({ length: 50 }, (_, index) => `src/related-${index}.ts`),
    tests: Array.from({ length: 25 }, (_, index) => `tests/workflow-${index}.test.ts`),
    steps: Array.from({ length: 17 }, (_, index) => ({
      kind: index === 0 ? "entry" as const : "call" as const,
      label: `step-${index}`,
      path: `src/step-${index}.ts`,
      confidence: "derived" as const,
      reason: `bounded step ${index}`
    })),
    summary: "A workflow with bounded construction evidence.",
    rank: 8,
    truncation: {
      steps: { total: 22, returned: 16 },
      executionSurfaces: { total: 70, returned: 64 }
    }
  };
}
