import { describe, expect, it } from "vitest";
import { recommendNextCodexaCall } from "../src/query/graph.js";

describe("query graph routing", () => {
  it("uses the explicit caller target instead of retrieval rank order", () => {
    const nextCall = recommendNextCodexaCall([], [], 0, "Callers for src/beta.ts", ["src/alpha.ts", "src/beta.ts"]);

    expect(nextCall).toMatchObject({ tool: "callers", arguments: { file: "src/beta.ts" } });
  });

  it("preserves explicit dependency endpoint order", () => {
    const nextCall = recommendNextCodexaCall([], [], 0, "Dependency path from src/beta.ts to src/alpha.ts", ["src/alpha.ts", "src/beta.ts"]);

    expect(nextCall).toMatchObject({
      tool: "dependency_path",
      arguments: { fromFile: "src/beta.ts", toFile: "src/alpha.ts" }
    });
  });
});
