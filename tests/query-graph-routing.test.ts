import { describe, expect, it } from "vitest";
import { ambiguousFocusTargetCandidates, classifyChangePlanNeed, focusFilesInTaskOrder, isLikelyPathTypo, isStructuralEditTask, plannedNewFocusPathTargets, recommendNextCodexaCall, unresolvedFocusPathTargets } from "../src/query/graph.js";
import { taskReferencesDirtyContext } from "../src/query/context/focus.js";
import { normalizeInputPath } from "../src/query/targets.js";

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

  it("does not treat a path prefix as the explicit target", () => {
    const nextCall = recommendNextCodexaCall([], [], 0, "Callers for src/beta.tsx", ["src/beta.ts", "src/beta.tsx"]);

    expect(nextCall).toMatchObject({ tool: "callers", arguments: { file: "src/beta.tsx" } });
  });

  it("allows an explicit root path to disambiguate a colliding basename", () => {
    const nextCall = recommendNextCodexaCall([], [], 0, "Callers for ./README.md", ["README.md", "docs/README.md"], {
      mode: "orientation",
      repositoryFiles: ["README.md", "docs/README.md"]
    });

    expect(nextCall).toMatchObject({ tool: "callers", arguments: { file: "README.md" } });
  });

  it("normalizes nested ./ paths and preserves case-distinct exact targets", () => {
    const repositoryFiles = ["README.md", "readme.md", "src/a.ts", "src/b.ts"];
    expect(focusFilesInTaskOrder("Callers for ./README.md", repositoryFiles, repositoryFiles)).toEqual(["README.md"]);
    expect(focusFilesInTaskOrder("Callers for ./readme.md", repositoryFiles, repositoryFiles)).toEqual(["readme.md"]);
    expect(recommendNextCodexaCall([], [], 0, "Dependency path between ./src/a.ts and ./src/b.ts", repositoryFiles, {
      mode: "orientation",
      repositoryFiles
    })).toMatchObject({ tool: "dependency_path", arguments: { fromFile: "src/a.ts", toFile: "src/b.ts" } });
  });

  it("keeps a bare colliding basename ambiguous even when another occurrence is exact", () => {
    expect(ambiguousFocusTargetCandidates("Dependency path between config.ts and src/a/config.ts", ["src/a/config.ts", "src/b/config.ts"])).toEqual([
      "src/a/config.ts",
      "src/b/config.ts"
    ]);
  });

  it("keeps terminal punctuation in basename ambiguity checks", () => {
    expect(ambiguousFocusTargetCandidates("Fix config.ts.", ["src/a/config.ts", "src/b/config.ts"])).toEqual([
      "src/a/config.ts",
      "src/b/config.ts"
    ]);
  });

  it("recognizes explicit and compact new-target syntax without accepting likely typos", () => {
    const repositoryFiles = ["src/util.ts"];
    expect(plannedNewFocusPathTargets("Create ./util.ts", repositoryFiles)).toEqual(["util.ts"]);
    expect(plannedNewFocusPathTargets("Create src/../new.ts", repositoryFiles)).toEqual([]);
    expect(unresolvedFocusPathTargets("Create src/../new.ts", repositoryFiles)).toEqual(["src/../new.ts"]);
    expect(plannedNewFocusPathTargets("Create src/./util.ts", repositoryFiles)).toEqual([]);
    expect(unresolvedFocusPathTargets("Create src/./util.ts", repositoryFiles)).toEqual([]);
    expect(focusFilesInTaskOrder("Create src/./util.ts", repositoryFiles, repositoryFiles)).toEqual(["src/util.ts"]);
    expect(plannedNewFocusPathTargets("Rename src/util.ts->src/helpers.ts", repositoryFiles)).toEqual(["src/helpers.ts"]);
    expect(plannedNewFocusPathTargets("Rename src/util.ts to [src/helpers.ts]", repositoryFiles)).toEqual(["src/helpers.ts"]);
    expect(plannedNewFocusPathTargets("Create src/new.ts,src/worker.ts", repositoryFiles)).toEqual(["src/new.ts", "src/worker.ts"]);
    expect(plannedNewFocusPathTargets("Create files:\n1. src/a.ts\n2. src/b.ts", repositoryFiles)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plannedNewFocusPathTargets("Create files:\n- [ ] src/a.ts\n- [ ] src/b.ts", repositoryFiles)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plannedNewFocusPathTargets("Create files src/a.ts; src/b.ts", repositoryFiles)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plannedNewFocusPathTargets("Create files src/util.ts and src/new.ts", repositoryFiles)).toEqual(["src/new.ts"]);
    expect(plannedNewFocusPathTargets("Create src/a.ts, src/util.ts, src/b.ts", repositoryFiles)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plannedNewFocusPathTargets("Create src/other.ts and src/utl.ts", repositoryFiles)).toEqual(["src/other.ts"]);
    expect(plannedNewFocusPathTargets("Convert src/util.ts to src/util.mjs", repositoryFiles)).toEqual(["src/util.mjs"]);
    expect(plannedNewFocusPathTargets("Relocate src/util.ts to src/lib/util.ts", repositoryFiles)).toEqual(["src/lib/util.ts"]);
    expect(plannedNewFocusPathTargets("Transform src/util.ts into src/modern.ts", repositoryFiles)).toEqual(["src/modern.ts"]);
    expect(plannedNewFocusPathTargets("Save the report to docs/report.md", repositoryFiles)).toEqual(["docs/report.md"]);
    expect(plannedNewFocusPathTargets("Write report to docs/report.md", repositoryFiles)).toEqual(["docs/report.md"]);
    expect(plannedNewFocusPathTargets("Document the API in docs/api.md", repositoryFiles)).toEqual(["docs/api.md"]);
    expect(isLikelyPathTypo("src/utli.ts", repositoryFiles)).toBe(true);
    expect(isLikelyPathTypo("src/uitl.ts", repositoryFiles)).toBe(true);
  });

  it("separates dependency specifiers, external destinations, and real new repository targets", () => {
    const repositoryFiles = ["src/util.ts", "package.json", "pnpm-lock.yaml"];
    for (const task of [
      "Fix the react/jsx-runtime.js import in src/util.ts",
      "Inspect react/jsx-runtime.js usage in src/util.ts",
      "Upgrade react/jsx-runtime.js in package.json",
      "Migrate from react/jsx-runtime.js to react/jsx-runtime.mjs in src/util.ts",
      "Update react/jsx-runtime.js in pnpm-lock.yaml"
    ]) {
      expect(plannedNewFocusPathTargets(task, repositoryFiles), task).toEqual([]);
      expect(unresolvedFocusPathTargets(task, repositoryFiles), task).toEqual([]);
    }
    expect(plannedNewFocusPathTargets("Create lib/new.ts and update package.json", repositoryFiles)).toEqual(["lib/new.ts"]);
    expect(plannedNewFocusPathTargets("Create src/new.ts that imports react/jsx-runtime.js", repositoryFiles)).toEqual(["src/new.ts"]);
    expect(unresolvedFocusPathTargets("Create src/new.ts that imports react/jsx-runtime.js", repositoryFiles)).toEqual([]);
    expect(plannedNewFocusPathTargets("Move src/util.ts to lib/util.ts and update package.json", repositoryFiles)).toEqual(["lib/util.ts"]);
    for (const [task, target] of [
      ["Move src/util.ts to /tmp/lib", "/tmp/lib"],
      ["Move src/util.ts to `/tmp/lib`.", "/tmp/lib"],
      ["Move src/util.ts to (../outside.ts).", "../outside.ts"],
      ["Rename src/util.ts to ../outside/Dockerfile", "../outside/Dockerfile"],
      ["Move src/util.ts to https://example.com/new.ts", "https://example.com/new.ts"]
    ] as const) {
      expect(unresolvedFocusPathTargets(task, repositoryFiles), task).toContain(target);
    }
    expect(unresolvedFocusPathTargets("Add a link to https://example.com/docs in src/util.ts", repositoryFiles)).toEqual([]);
    expect(plannedNewFocusPathTargets("Create .github/workflows/ci.yml", repositoryFiles)).toEqual([".github/workflows/ci.yml"]);
    expect(unresolvedFocusPathTargets("Create .github/workflows/ci.yml", repositoryFiles)).toEqual([]);
  });

  it("requires a concrete structural destination construction", () => {
    for (const task of [
      "Move forward with creating src/new.ts",
      "Copy the existing pattern and create src/new.ts",
      "Extract the requirements and create src/new.ts",
      "Rename the concept and create src/new.ts"
    ]) expect(isStructuralEditTask(task), task).toBe(false);
    for (const task of [
      "Move src/util.ts to src/new.ts",
      "Copy src/util.ts as src/new.ts",
      "Extract helper into src/new.ts",
      "Rename helper as src/new.ts",
      "Convert src/util.ts to src/util.mjs"
    ]) expect(isStructuralEditTask(task), task).toBe(true);
  });

  it("requires contextual language before treating code words as dirty-worktree scope", () => {
    for (const task of ["Fix the diff algorithm", "Update the worktree parser", "Fix the dirty flag", "Update the staged state handler"]) {
      expect(taskReferencesDirtyContext(task), task).toBe(false);
    }
    for (const task of ["Fix the current diff", "Review staged changes", "Fix dirty files", "Update my changes"]) {
      expect(taskReferencesDirtyContext(task), task).toBe(true);
    }
  });

  it("canonicalizes benign dot paths and rejects traversal", () => {
    expect(normalizeInputPath("src/../src/util.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("src/./util.ts", "/repo")).toBe("src/util.ts");
    expect(normalizeInputPath("./util.ts", "/repo")).toBe("util.ts");
    expect(normalizeInputPath("../outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("/tmp/outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("~/outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("$HOME/outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("file:///tmp/outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("C:/outside.ts", "/repo")).toBeUndefined();
    expect(normalizeInputPath("\\\\server\\share\\outside.ts", "/repo")).toBeUndefined();
  });

  it("preserves every explicit plan target accepted by change_plan", () => {
    const targets = Array.from({ length: 9 }, (_, index) => `src/file-${index + 1}.ts`);
    const nextCall = recommendNextCodexaCall(["implementation"], [], 0, `Refactor ${targets.join(" and ")}`, targets.slice(0, 3), {
      mode: "edit",
      explicitTargetCount: targets.length,
      targetFiles: targets,
      repositoryFiles: targets
    });

    expect(nextCall).toMatchObject({ tool: "change_plan", arguments: { files: targets } });
  });

  it("plans explicit multi-target and plural-risk edits", () => {
    expect(classifyChangePlanNeed({ mode: "edit", task: "Refactor two helpers", explicitTargetCount: 2 })?.trigger).toBe("multiple-targets");
    expect(classifyChangePlanNeed({ mode: "edit", task: "Harden permissions in src/auth.ts", explicitTargetCount: 1 })?.trigger).toBe("material-risk");
    expect(classifyChangePlanNeed({ mode: "edit", task: "Refactor across modules", explicitTargetCount: 1 })?.trigger).toBe("multi-file");
  });

  it("does not plan read-only multi-target work or a single low-risk edit", () => {
    expect(classifyChangePlanNeed({ mode: "orientation", task: "Inspect src/a.ts and src/b.ts", explicitTargetCount: 2 })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update src/a.ts return value", explicitTargetCount: 1 })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update src/api.ts return value", explicitTargetCount: 1 })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update src/a.ts behavior", explicitTargetCount: 1, changeType: "behavior" })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update API behavior in src/api.ts", explicitTargetCount: 1 })?.trigger).toBe("material-risk");
    expect(classifyChangePlanNeed({ mode: "edit", task: "Style API label in src/api.ts", explicitTargetCount: 1, changeType: "style" })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Harden security wording", explicitTargetCount: 1, targetFiles: ["README.md"] })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update contracts", explicitTargetCount: 2, targetFiles: ["README.md", "docs/contracts.md"] })).toBeUndefined();
    expect(classifyChangePlanNeed({ mode: "edit", task: "Harden security in src/docs.ts", explicitTargetCount: 1, targetFiles: ["src/docs.ts"] })?.trigger).toBe("material-risk");
    expect(classifyChangePlanNeed({ mode: "edit", task: "Update README.md and the API contract in src/api.ts", explicitTargetCount: 2, targetFiles: ["README.md", "src/api.ts"] })?.trigger).toBe("material-risk");
  });

  it("plans structural, destructive-symbol, vulnerability, concurrency, and integrity risk", () => {
    const target = { explicitTargetCount: 1, targetFiles: ["src/util.ts"] };
    for (const task of [
      "Move src/util.ts out of the package",
      "Migrate src/util.ts to the new layout",
      "Move src/util.ts into the helpers module",
      "Migrate src/util.ts into package v2",
      "Remove src/util.ts",
      "Remove helper",
      "Rename helper",
      "Fix SQL injection in src/util.ts",
      "Prevent path traversal in src/util.ts",
      "Fix an SSRF in src/util.ts",
      "Resolve a race condition in src/util.ts",
      "Prevent data loss in src/util.ts",
      "Make writes atomic in src/util.ts",
      "Fix cache invalidation in src/util.ts"
    ]) {
      expect(classifyChangePlanNeed({ mode: "edit", task, ...target })?.trigger, task).toBe("material-risk");
    }
    for (const task of [
      "Rename a local variable in src/util.ts",
      "Remove an unused import from src/util.ts",
      "Delete dead local code in src/util.ts",
      "Move a helper within the same file src/util.ts",
      "Extract a local helper within the same file src/util.ts",
      "Rename private helper in src/util.ts",
      "Remove dead code in src/util.ts",
      "Update docs for public API in src/util.ts"
    ]) {
      expect(classifyChangePlanNeed({ mode: "edit", task, ...target }), task).toBeUndefined();
    }
  });
});
