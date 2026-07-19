import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery, contextPackQuery, focusBriefQuery, searchQuery } from "../src/queries.js";
import { createFixtureRepo } from "./indexer-fixtures.js";

describe("query routing boundaries", () => {
  it("keeps change-inspection prompts in read-only orientation", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const tasks = [
      "What changed in src/util.ts?",
      "Review changes in src/util.ts",
      "Review the API change in src/util.ts",
      "Inspect the security change in src/util.ts",
      "Explain the schema change in src/util.ts",
      "Review the API update in src/util.ts",
      "What was updated in src/util.ts?",
      "Inspect the renamed API in src/util.ts",
      "Explain the API bug in src/util.ts",
      "Inspect how auth was implemented in src/util.ts",
      "Create a report of API callers in src/util.ts",
      "Review src/util.ts, then debug the auth failure",
      "Make sense of the API in src/util.ts",
      "Build an understanding of the API in src/util.ts",
      "Create a test plan for the API in src/util.ts",
      "Show changes across src/util.ts and src/constants.ts",
      "Show deleted files in src/util.ts",
      "Which files changed in src?",
      "What changes did this commit make in src/util.ts?",
      "Compare changes in src/util.ts"
    ];

    for (const task of tasks) {
      const result = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      const data = result.data as { intentConfidence: { mode: string }; nextCall: { tool: string } };
      expect(data.intentConfidence.mode, task).toBe("orientation");
      expect(data.nextCall.tool, task).not.toBe("change_plan");
      if (task.includes("src/util.ts") && !task.includes("callers")) expect(data.nextCall.tool, task).toBe("source");
    }

    for (const task of ["Show callers of helper", "Inspect src/util.ts", "Review src/util.ts", "Explain VALUE in src/constants.ts"]) {
      const search = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((search.data as { intentConfidence: { mode: string }; actionability: string; nextTools?: unknown[] }), task).toMatchObject({
        intentConfidence: { mode: "orientation" },
        nextTools: []
      });
      expect((search.data as { actionability: string }).actionability, task).not.toBe("edit_ready");
    }

    const defaultFocus = await focusBriefQuery(repo, { diff: false }, { autoRefresh: false });
    expect((defaultFocus.data as { intentConfidence: { mode: string }; nextCall: { tool: string } }).intentConfidence.mode).toBe("orientation");
    expect((defaultFocus.data as { nextCall: { tool: string } }).nextCall.tool).not.toBe("change_plan");

    for (const task of [
      "Restrict permissions in src/util.ts",
      "Synchronize src/util.ts and src/constants.ts",
      "Need to harden API permissions in src/util.ts",
      "Task: Harden API permissions in src/util.ts",
      "Context first. Harden API permissions in src/util.ts",
      "Make src/util.ts enforce permissions",
      "Resolve the API bug in src/util.ts",
      "Apply the security fix in src/util.ts",
      "We should fix API permissions in src/util.ts",
      "Please can you fix API permissions in src/util.ts",
      "Ensure API permissions in src/util.ts",
      "Improve API permissions in src/util.ts",
      "Upgrade API behavior in src/util.ts",
      "Correct API permissions in src/util.ts",
      "Set API permissions in src/util.ts",
      "Extract API permissions from src/util.ts",
      "Patch API auth in src/api.ts",
      "Adjust API auth in src/api.ts",
      "Revise API auth in src/api.ts",
      "Enable API auth in src/api.ts",
      "I need API auth fixed in src/api.ts",
      "API auth should be fixed in src/api.ts",
      "The API auth needs fixing in src/api.ts",
      "Can we fix API auth in src/api.ts?",
      "Please help fix API auth in src/api.ts",
      "Remove src/util.ts",
      "Move src/util.ts out of the package",
      "Migrate src/util.ts to the new layout",
      "Update the endpoint in src/api.ts",
      "Update the exported type in src/contracts.ts",
      "Change the exported function in src/api.ts",
      "Change the public method signature in src/contracts.ts",
      "Change the endpoint response in src/api.ts",
      "Update access control in src/api.ts",
      "Fix credential handling in src/api.ts",
      "Update the route response in src/api.ts"
    ]) {
      const result = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((result.data as { nextCall: { tool: string } }).nextCall.tool, task).toBe("change_plan");
    }

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 2 }\n", "utf8");
    const dirtyDefault = await focusBriefQuery(repo, {}, { autoRefresh: false });
    expect((dirtyDefault.data as { intentConfidence: { mode: string }; nextCall: { tool: string } }).intentConfidence.mode).toBe("orientation");
    expect((dirtyDefault.data as { nextCall: { tool: string } }).nextCall.tool).not.toBe("change_plan");

    for (const task of [
      "Fix a typo in src/api.ts and src/util.ts",
      "Update comments in src/api.ts and src/util.ts",
      "Correct formatting in src/api.ts and src/util.ts",
      "Update copyright wording in src/api.ts and src/util.ts",
      "Update export formatting in src/util.ts",
      "Fix route sorting in src/util.ts",
      "Change route metadata in src/util.ts",
      "Update how src/util.ts routes values"
    ]) {
      const result = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((result.data as { nextCall: { tool: string } }).nextCall.tool, task).not.toBe("change_plan");
    }
  });

  it("disambiguates colliding doc basenames without planning docs-only risk wording", async () => {
    const repo = await createFixtureRepo();
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Root\n\nSecurity wording.\n", "utf8");
    await writeFile(path.join(repo, "docs/README.md"), "# Docs\n\nSecurity wording.\n", "utf8");
    await buildIndex({ repoRoot: repo });

    const ambiguousTask = "Harden security wording in README.md";
    const ambiguousFocus = await focusBriefQuery(repo, { task: ambiguousTask, diff: false, limit: 8, tokenBudget: 1200 }, { autoRefresh: false });
    expect((ambiguousFocus.data as { nextCall: { tool: string; reason: string } }).nextCall).toMatchObject({
      tool: "search",
      reason: expect.stringContaining("matches multiple repository files")
    });

    const ambiguousSearch = await searchQuery(repo, { query: ambiguousTask, limit: 8 }, { autoRefresh: false });
    const ambiguousSearchData = ambiguousSearch.data as { nextTools?: unknown[]; targetCandidates?: string[] };
    expect(ambiguousSearchData.nextTools).toEqual([]);
    expect(ambiguousSearchData.targetCandidates).toEqual(["README.md", "docs/README.md"]);
    expect(ambiguousSearch.text).toContain("Ambiguous target candidates:");
    expect(ambiguousSearch.text).toContain("- README.md");
    expect(ambiguousSearch.text).toContain("- docs/README.md");

    const rootTask = "Harden security wording in ./README.md";
    const rootFocus = await focusBriefQuery(repo, { task: rootTask, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((rootFocus.data as { nextCall: { tool: string }; focusFiles: Array<{ path: string }> }).nextCall.tool).toBe("source");
    expect((rootFocus.data as { focusFiles: Array<{ path: string }> }).focusFiles[0]?.path).toBe("README.md");
    const rootSearch = await searchQuery(repo, { query: rootTask, limit: 6 }, { autoRefresh: false });
    expect((rootSearch.data as { nextTools?: unknown[]; targetCandidates?: string[] }).nextTools).toEqual([]);
    expect((rootSearch.data as { targetCandidates?: string[] }).targetCandidates).toEqual([]);

    const exactTask = "Harden security wording in docs/README.md";
    const exactFocus = await focusBriefQuery(repo, { task: exactTask, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((exactFocus.data as { nextCall: { tool: string } }).nextCall.tool).toBe("source");

    const exactSearch = await searchQuery(repo, { query: exactTask, limit: 6 }, { autoRefresh: false });
    expect((exactSearch.data as { nextTools?: unknown[] }).nextTools).toEqual([]);

    const exactPack = await contextPackQuery(
      repo,
      { task: "Harden security wording", files: ["docs/README.md"], diff: false, includeSnippets: false, limit: 4, tokenBudget: 900 },
      { autoRefresh: false }
    );
    expect((exactPack.data as { nextTools?: unknown[] }).nextTools).toEqual([]);

    const ambiguousSourceTask = "Harden runtime behavior in config.ts";
    const ambiguousSourceFocus = await focusBriefQuery(repo, { task: ambiguousSourceTask, diff: false, limit: 8, tokenBudget: 1200 }, { autoRefresh: false });
    expect((ambiguousSourceFocus.data as { actionability: string; packetVerdict: string; nextCall: { tool: string } })).toMatchObject({
      actionability: "needs_target",
      packetVerdict: "needs-target",
      nextCall: { tool: "search" }
    });
    const ambiguousSourceSearch = await searchQuery(repo, { query: ambiguousSourceTask, limit: 8 }, { autoRefresh: false });
    expect((ambiguousSourceSearch.data as { actionability: string; packetVerdict: string; intentConfidence: { editReady: boolean } })).toMatchObject({
      actionability: "needs_target",
      packetVerdict: "needs-target",
      intentConfidence: { editReady: false }
    });

    const unresolvedPack = await contextPackQuery(
      repo,
      { task: "Harden the API contract", files: ["config.ts"], diff: false, includeSnippets: false, limit: 6, tokenBudget: 1000 },
      { autoRefresh: false }
    );
    expect((unresolvedPack.data as { actionability: string; packetVerdict: string; nextTools?: Array<{ tool?: string }> })).toMatchObject({
      actionability: "needs_target",
      packetVerdict: "needs-target",
      nextTools: [expect.objectContaining({ tool: "search" })]
    });
    const unresolvedSearchQuery = (unresolvedPack.data as { nextTools?: Array<{ requiredInputs?: { query?: string } }> }).nextTools?.[0]?.requiredInputs?.query;
    expect(unresolvedSearchQuery).toContain("Harden the API contract");
    expect(unresolvedSearchQuery).toContain("config.ts");
    const recoveredSearch = await searchQuery(repo, { query: unresolvedSearchQuery ?? "", limit: 8 }, { autoRefresh: false });
    expect((recoveredSearch.data as { targetCandidates?: string[] }).targetCandidates).toEqual(["src/a/config.ts", "src/b/config.ts"]);

    const directAmbiguous = await changePlanQuery(repo, { task: "Harden config.ts", files: ["config.ts"], diff: false, saveSnapshot: false }, { autoRefresh: false });
    const directAmbiguousData = directAmbiguous.data as { targetCandidates?: Array<{ kind: string; path: string }>; nextTools?: unknown[] };
    expect(directAmbiguousData.nextTools).toEqual([]);
    expect(directAmbiguousData.targetCandidates?.map((candidate) => `${candidate.kind}:${candidate.path}`)).toEqual([
      "file:src/a/config.ts",
      "file:src/b/config.ts"
    ]);

    const noSnapshotPlan = await changePlanQuery(repo, { task: "Fix helper", taskId: "unsaved-task-id", files: ["src/util.ts"], diff: false, saveSnapshot: false }, { autoRefresh: false });
    expect((noSnapshotPlan.data as { nextTools?: unknown[] }).nextTools).toEqual([]);
    expect(noSnapshotPlan.text).toContain("saveSnapshot=false means no drift-review follow-up");

    const materialMissing = await contextPackQuery(repo, { task: "Harden the endpoint", files: ["src/not-real.ts"], changeType: "api", diff: false, includeSnippets: false }, { autoRefresh: false });
    expect((materialMissing.data as { actionability: string; nextTools?: Array<{ tool?: string }> })).toMatchObject({
      actionability: "needs_target",
      nextTools: [expect.objectContaining({ tool: "search" })]
    });

    for (const task of [
      "Update API documentation comments in src/api.ts",
      "Update security comments in src/api.ts",
      "Harden security wording in src/api.ts",
      "Remove stale API documentation comments in src/api.ts",
      "Delete the security comment in src/api.ts",
      "Rename API wording in src/api.ts",
      "Move the auth comment in src/api.ts",
      "Migrate API docs in src/api.ts"
    ]) {
      const focus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((focus.data as { nextCall: { tool: string } }).nextCall.tool, task).not.toBe("change_plan");
      const search = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((search.data as { nextTools?: unknown[] }).nextTools, task).toEqual([]);
      const pack = await contextPackQuery(repo, { task, files: ["src/api.ts"], diff: false, includeSnippets: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
      expect((pack.data as { nextTools?: unknown[] }).nextTools, task).toEqual([]);
    }

    for (const task of ["Harden security wording", "Update public interface documentation", "Refactor schema documentation"]) {
      const focus = await focusBriefQuery(repo, { task, diff: false, limit: 8, tokenBudget: 1200 }, { autoRefresh: false });
      expect((focus.data as { nextCall: { tool: string } }).nextCall.tool, task).not.toBe("change_plan");
      const search = await searchQuery(repo, { query: task, limit: 8 }, { autoRefresh: false });
      expect((search.data as { nextTools?: unknown[] }).nextTools, task).toEqual([]);
    }
  });

  it("routes an explicitly requested dirty edit scope consistently", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 2 }\n", "utf8");
    await writeFile(path.join(repo, "src/constants.ts"), "export const VALUE = 2\n", "utf8");

    const focus = await focusBriefQuery(repo, { task: "Fix the current changes", diff: true, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    expect((focus.data as { actionability: string; nextCall: { tool: string; arguments?: { diff?: boolean; files?: string[] } } })).toMatchObject({
      actionability: "edit_ready",
      nextCall: { tool: "change_plan", arguments: { diff: true } }
    });
    expect((focus.data as { nextCall: { arguments?: { files?: string[] } } }).nextCall.arguments?.files).toBeUndefined();

    const pack = await contextPackQuery(
      repo,
      { task: "Fix the current changes", diff: true, includeSnippets: false, limit: 6, tokenBudget: 1200 },
      { autoRefresh: false }
    );
    expect((pack.data as { nextTools?: Array<{ tool?: string; requiredInputs?: { diff?: boolean; files?: string[] } }> }).nextTools).toEqual([
      expect.objectContaining({ tool: "change_plan", requiredInputs: expect.objectContaining({ diff: true }) })
    ]);
    expect((pack.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files).toBeUndefined();

    for (const task of ["Fix uncommitted changes", "Fix modified files", "Fix pending changes", "Fix the local changes"]) {
      const dirtyFocus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((dirtyFocus.data as { nextCall: { tool: string; arguments?: { diff?: boolean } } }).nextCall, task).toMatchObject({ tool: "change_plan", arguments: { diff: true } });
    }

    for (const task of ["Fix the diff algorithm in src/util.ts", "Update the worktree parser in src/util.ts", "Fix the dirty flag in src/util.ts", "Update the staged state handler in src/util.ts"]) {
      const codeWordFocus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((codeWordFocus.data as { intentConfidence: { mode: string }; nextCall: { arguments?: { diff?: boolean } } }).intentConfidence.mode, task).toBe("edit");
      expect((codeWordFocus.data as { nextCall: { arguments?: { diff?: boolean } } }).nextCall.arguments?.diff, task).not.toBe(true);
    }

    for (const [task, expectedFile] of [["Fix current changes in helper", "src/util.ts"], ["Fix current changes to VALUE", "src/constants.ts"]]) {
      const narrowed = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((narrowed.data as { nextCall: { tool: string; arguments?: { diff?: boolean; files?: string[] } } }).nextCall, task).toMatchObject({
        tool: "change_plan",
        arguments: { diff: false, files: [expectedFile] }
      });
    }

    for (const task of ["Fix the API regression caused by recent changes", "Harden authentication after upstream changes", "Repair runtime behavior that changed last release"]) {
      const historicalFocus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      const arguments_ = (historicalFocus.data as { nextCall: { arguments?: { diff?: boolean } } }).nextCall.arguments;
      expect(arguments_?.diff, task).not.toBe(true);
    }
  });

  it("keeps an untracked-only dirty scope executable through change_plan", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/untracked-new.ts"), "export const untrackedNew = true\n", "utf8");

    const task = "Fix current changes";
    const focus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((focus.data as { nextCall: { tool: string; arguments?: { diff?: boolean } } }).nextCall).toMatchObject({ tool: "change_plan", arguments: { diff: true } });
    const pack = await contextPackQuery(repo, { task, diff: true, includeSnippets: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((pack.data as { dirtyScope?: { plannedEditTargets?: string[] }; nextTools?: Array<{ tool?: string }> })).toMatchObject({
      dirtyScope: { plannedEditTargets: ["src/untracked-new.ts"] },
      nextTools: [expect.objectContaining({
        tool: "change_plan",
        readOnly: false,
        writes: [".codex/cache/codexa-tasks", ".codex/cache/codexa-task-lifecycle"]
      })]
    });
    const plan = await changePlanQuery(repo, { task, diff: true, saveSnapshot: false }, { autoRefresh: false });
    expect((plan.data as { editReadiness: { editable: boolean; source: string }; plannedEditTargets?: string[]; nextTools?: unknown[] })).toMatchObject({
      editReadiness: { editable: true, source: "dirty-worktree" },
      plannedEditTargets: ["src/untracked-new.ts"],
      nextTools: []
    });
  });

  it("stops clean dirty-scope requests without retrieving unrelated source", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    for (const task of ["Fix current changes", "Review current changes"]) {
      const focus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, {
        autoRefresh: false,
        semantic: true,
        semanticProvider: "local-command",
        semanticCommand: "/definitely/not/invoked-by-dirty-scope"
      });
      expect((focus.data as {
        actionability: string;
        focusFiles: unknown[];
        modules: unknown[];
        nextCall: { tool: string };
        retrieval: { semantic: { status: string } };
      }), task).toMatchObject({
        actionability: "orientation",
        focusFiles: [],
        modules: [],
        nextCall: { tool: "none" },
        retrieval: { semantic: { status: "disabled" } }
      });
      expect(focus.text, task).toContain("the worktree is clean");
    }

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 7 }\n", "utf8");
    const diffDisabled = await focusBriefQuery(repo, { task: "Fix current changes", diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((diffDisabled.data as { nextCall: { tool: string } }).nextCall.tool).not.toBe("none");
    expect(diffDisabled.text).not.toContain("the worktree is clean");
  });

  it("resolves each dirty basename ambiguity independently", async () => {
    const repo = await createFixtureRepo();
    await writeFile(path.join(repo, "src/a/index.ts"), "export const indexA = 1\n", "utf8");
    await writeFile(path.join(repo, "src/b/index.ts"), "export const indexB = 2\n", "utf8");
    execFileSync("git", ["add", "src/a/index.ts", "src/b/index.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add index collisions"], { cwd: repo, stdio: "ignore" });
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/a/config.ts"), "export function config() { return 'dirty-a' }\n", "utf8");
    await writeFile(path.join(repo, "src/b/index.ts"), "export const indexB = 3\n", "utf8");

    const task = "Fix current changes in config.ts and index.ts";
    const focus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((focus.data as { actionability: string; targetCandidates?: string[]; nextCall: { tool: string; arguments?: { files?: string[] } } })).toMatchObject({
      actionability: "edit_ready",
      targetCandidates: [],
      nextCall: { tool: "change_plan", arguments: { files: ["src/a/config.ts", "src/b/index.ts"] } }
    });
    const plan = await changePlanQuery(repo, { task, diff: true, saveSnapshot: false }, { autoRefresh: false });
    expect((plan.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[] })).toMatchObject({
      editReadiness: { editable: true },
      plannedEditTargets: ["src/a/config.ts", "src/b/index.ts"]
    });

    await writeFile(path.join(repo, "src/a/index.ts"), "export const indexA = 4\n", "utf8");
    const mixedFocus = await focusBriefQuery(repo, { task, diff: true, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((mixedFocus.data as { actionability: string; targetCandidates?: string[]; nextCall: { tool: string } })).toMatchObject({
      actionability: "needs_target",
      targetCandidates: ["src/a/index.ts", "src/b/index.ts"],
      nextCall: { tool: "search" }
    });
    const mixedPack = await contextPackQuery(repo, { task, diff: true, includeSnippets: false }, { autoRefresh: false });
    expect((mixedPack.data as { actionability: string; nextTools?: Array<{ tool?: string }> })).toMatchObject({
      actionability: "needs_target",
      nextTools: [expect.objectContaining({ tool: "search" })]
    });
    const mixedPlan = await changePlanQuery(repo, { task, diff: true, saveSnapshot: false }, { autoRefresh: false });
    expect((mixedPlan.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[] })).toMatchObject({
      editReadiness: { editable: false },
      plannedEditTargets: []
    });

    await writeFile(path.join(repo, "src/a/local.ts"), "export const localA = 1\n", "utf8");
    execFileSync("git", ["add", "src/a/local.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add tracked local collision"], { cwd: repo, stdio: "ignore" });
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/a/local.ts"), "export const localA = 2\n", "utf8");
    await writeFile(path.join(repo, "src/b/local.ts"), "export const localB = 2\n", "utf8");
    const untrackedCollisionTask = "Fix current changes in local.ts";
    for (const result of [
      await focusBriefQuery(repo, { task: untrackedCollisionTask, diff: true }, { autoRefresh: false }),
      await contextPackQuery(repo, { task: untrackedCollisionTask, diff: true, includeSnippets: false }, { autoRefresh: false })
    ]) {
      expect((result.data as { actionability: string }).actionability).toBe("needs_target");
    }
    const untrackedCollisionPlan = await changePlanQuery(repo, { task: untrackedCollisionTask, diff: true, saveSnapshot: false }, { autoRefresh: false });
    expect((untrackedCollisionPlan.data as { editReadiness: { editable: boolean } }).editReadiness.editable).toBe(false);
  });

  it("keeps structured structural scopes consistent with natural endpoints", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const task = "Rename src/util.ts to src/helpers/util.ts";

    for (const files of [["src/util.ts"], ["src/helpers/util.ts"]]) {
      const pack = await contextPackQuery(repo, { task, files, changeType: "rename", diff: false, includeSnippets: false }, { autoRefresh: false });
      expect((pack.data as { actionability: string; nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }), files[0]).toMatchObject({
        actionability: "edit_ready",
        nextTools: [expect.objectContaining({
          requiredInputs: expect.objectContaining({ files: ["src/util.ts", "src/helpers/util.ts"] }),
          readOnly: false,
          writes: [".codex/cache/codexa-tasks", ".codex/cache/codexa-task-lifecycle"]
        })]
      });
      const plan = await changePlanQuery(repo, { task, files, changeType: "rename", diff: false, saveSnapshot: false }, { autoRefresh: false });
      expect((plan.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[] }), files[0]).toMatchObject({
        editReadiness: { editable: true },
        plannedEditTargets: ["src/helpers/util.ts", "src/util.ts"]
      });
    }

    const disambiguatedTask = "Rename sharedHelper to src/new.ts";
    const disambiguatedPack = await contextPackQuery(repo, { task: disambiguatedTask, files: ["src/ambiguous-a.ts"], changeType: "rename", diff: false, includeSnippets: false }, { autoRefresh: false });
    expect((disambiguatedPack.data as { actionability: string; boundedPlanTargets?: string[]; targetCandidates?: string[] })).toMatchObject({
      actionability: "edit_ready",
      boundedPlanTargets: ["src/new.ts", "src/ambiguous-a.ts"],
      targetCandidates: []
    });
    const disambiguatedPlan = await changePlanQuery(repo, { task: disambiguatedTask, files: ["src/ambiguous-a.ts"], changeType: "rename", diff: false, saveSnapshot: false }, { autoRefresh: false });
    expect((disambiguatedPlan.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[] })).toMatchObject({
      editReadiness: { editable: true },
      plannedEditTargets: ["src/ambiguous-a.ts", "src/new.ts"]
    });

    for (const [mismatchedTask, files] of [
      [task, ["src/api.ts"]],
      ["Fix src/util.ts", ["src/api.ts"]],
      ["Rename src/utl.ts to src/helpers/util.ts", ["src/helpers/util.ts"]]
    ] as const) {
      const pack = await contextPackQuery(repo, { task: mismatchedTask, files: [...files], changeType: mismatchedTask.startsWith("Rename") ? "rename" : "unknown", diff: false, includeSnippets: false }, { autoRefresh: false });
      expect((pack.data as { actionability: string }).actionability, mismatchedTask).toBe("needs_target");
      const plan = await changePlanQuery(repo, { task: mismatchedTask, files: [...files], changeType: mismatchedTask.startsWith("Rename") ? "rename" : "unknown", diff: false, saveSnapshot: false }, { autoRefresh: false });
      expect((plan.data as { editReadiness: { editable: boolean } }).editReadiness.editable, mismatchedTask).toBe(false);
    }

    const destinationOnlyTask = "Rename the file to ./renamed.ts";
    const destinationOnlyFocus = await focusBriefQuery(repo, { task: destinationOnlyTask, diff: false }, { autoRefresh: false });
    expect((destinationOnlyFocus.data as { actionability: string; unresolvedTargets?: string[] }).actionability).toBe("needs_target");
    const destinationOnlySearch = await searchQuery(repo, { query: destinationOnlyTask }, { autoRefresh: false });
    expect((destinationOnlySearch.data as { actionability: string }).actionability).toBe("needs_target");
    const destinationOnlyPack = await contextPackQuery(repo, { task: destinationOnlyTask, files: ["./renamed.ts"], changeType: "rename", diff: false, includeSnippets: false }, { autoRefresh: false });
    expect((destinationOnlyPack.data as { actionability: string }).actionability).toBe("needs_target");
    const destinationOnlyPlan = await changePlanQuery(repo, { task: destinationOnlyTask, files: ["./renamed.ts"], changeType: "rename", diff: false, saveSnapshot: false }, { autoRefresh: false });
    expect((destinationOnlyPlan.data as { editReadiness: { editable: boolean } }).editReadiness.editable).toBe(false);

    for (const standaloneTask of [
      "Move forward with creating src/forward.ts",
      "Copy the existing pattern and create src/copied.ts",
      "Extract the requirements and create src/requirements.ts"
    ]) {
      const standalone = await focusBriefQuery(repo, { task: standaloneTask, diff: false }, { autoRefresh: false });
      expect((standalone.data as { actionability: string }).actionability, standaloneTask).not.toBe("needs_target");
    }

    for (const [artifactTask, target] of [
      ["Save the report to docs/report.md", "docs/report.md"],
      ["Write report to docs/summary.md", "docs/summary.md"],
      ["Document the API in docs/api.md", "docs/api.md"]
    ] as const) {
      const artifactFocus = await focusBriefQuery(repo, { task: artifactTask, diff: false }, { autoRefresh: false });
      expect((artifactFocus.data as { actionability: string; unresolvedTargets?: string[] }).unresolvedTargets, artifactTask).toEqual([]);
      expect((artifactFocus.data as { actionability: string }).actionability, artifactTask).toBe("edit_ready");
      const artifactSearch = await searchQuery(repo, { query: artifactTask }, { autoRefresh: false });
      expect((artifactSearch.data as { actionability: string; unresolvedTargets?: string[] }), artifactTask).toMatchObject({ actionability: "edit_ready", unresolvedTargets: [] });
      const artifactPlan = await changePlanQuery(repo, { task: artifactTask, files: [target], diff: false, saveSnapshot: false }, { autoRefresh: false });
      expect((artifactPlan.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[] }), artifactTask).toMatchObject({
        editReadiness: { editable: true },
        plannedEditTargets: [target]
      });
    }
  });

  it("blocks quoted and unquoted external destinations on every planning surface", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    for (const task of ["Move src/util.ts to /tmp/lib", "Move src/util.ts to `/tmp/lib`.", "Move src/util.ts to (../outside.ts)."]) {
      expect((await focusBriefQuery(repo, { task, diff: false }, { autoRefresh: false }).then((result) => result.data) as { actionability: string }).actionability, task).toBe("needs_target");
      expect((await searchQuery(repo, { query: task }, { autoRefresh: false }).then((result) => result.data) as { actionability: string }).actionability, task).toBe("needs_target");
      expect((await contextPackQuery(repo, { task, files: ["src/util.ts"], diff: false, includeSnippets: false }, { autoRefresh: false }).then((result) => result.data) as { actionability: string }).actionability, task).toBe("needs_target");
      const plan = await changePlanQuery(repo, { task, files: ["src/util.ts"], diff: false, saveSnapshot: false }, { autoRefresh: false });
      expect((plan.data as { editReadiness: { editable: boolean } }).editReadiness.editable, task).toBe(false);
    }
  });

  it("blocks natural and structured new targets that escape through a symlink", async () => {
    const repo = await createFixtureRepo();
    const outside = `${repo}-outside`;
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(repo, "escape"), "dir");
    await symlink(`${repo}-missing-outside`, path.join(repo, "dangling-escape"), "dir");
    await buildIndex({ repoRoot: repo });
    for (const relativePath of ["escape/new.ts", "dangling-escape/new.ts"]) {
      const task = `Create ./${relativePath}`;
      const focus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((focus.data as { actionability: string; unresolvedTargets?: string[] })).toMatchObject({ actionability: "needs_target", unresolvedTargets: [relativePath] });
      const search = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((search.data as { actionability: string; unresolvedTargets?: string[]; nextTools?: unknown[] })).toMatchObject({ actionability: "needs_target", unresolvedTargets: [relativePath], nextTools: [] });
      const pack = await contextPackQuery(repo, { task, files: [`./${relativePath}`], diff: false, includeSnippets: false }, { autoRefresh: false });
      expect((pack.data as { actionability: string }).actionability).toBe("needs_target");
      const plan = await changePlanQuery(repo, { task, files: [`./${relativePath}`], diff: false, saveSnapshot: false }, { autoRefresh: false });
      expect((plan.data as { editReadiness: { editable: boolean } }).editReadiness.editable).toBe(false);
    }
  });

  it("keeps complete explicit and symbol-derived plan scopes", async () => {
    const repo = await createFixtureRepo();
    await mkdir(path.join(repo, "src/query"), { recursive: true });
    await writeFile(path.join(repo, "src/query/graph.ts"), "export function graphRoute() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "src/query/search.ts"), "export function searchRoute() { return 2 }\n", "utf8");
    const bulkTargets = Array.from({ length: 9 }, (_, index) => `src/bulk-${index + 1}.ts`);
    for (const [index, filePath] of bulkTargets.entries()) await writeFile(path.join(repo, filePath), `export const bulk${index + 1} = ${index + 1}\n`, "utf8");
    await buildIndex({ repoRoot: repo });

    const structuredSymbols = await contextPackQuery(
      repo,
      { task: "Refactor helper and VALUE to share logic", symbols: ["helper", "VALUE"], diff: false, includeSnippets: false, limit: 6, tokenBudget: 1200 },
      { autoRefresh: false }
    );
    expect((structuredSymbols.data as { actionability: string; nextTools?: Array<{ requiredInputs?: { files?: string[] } }> })).toMatchObject({
      actionability: "edit_ready",
      nextTools: [expect.objectContaining({ requiredInputs: expect.objectContaining({ files: ["src/util.ts", "src/constants.ts"] }) })]
    });

    const naturalTask = "Refactor helper and VALUE to share logic";
    const naturalFocus = await focusBriefQuery(repo, { task: naturalTask, diff: false, limit: 3, tokenBudget: 900 }, { autoRefresh: false });
    expect((naturalFocus.data as { nextCall: { tool: string; arguments?: { files?: string[] } } }).nextCall).toMatchObject({
      tool: "change_plan",
      arguments: { files: ["src/util.ts", "src/constants.ts"] }
    });
    const naturalSearch = await searchQuery(repo, { query: naturalTask, limit: 1 }, { autoRefresh: false });
    expect((naturalSearch.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools).toEqual([
      expect.objectContaining({ requiredInputs: expect.objectContaining({ files: ["src/util.ts", "src/constants.ts"] }) })
    ]);

    for (const [task, expectedFiles] of [
      ["Refactor src/util.ts and VALUE to share logic", ["src/util.ts", "src/constants.ts"]],
      ["Refactor VALUE and src/util.ts to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor helper and src/constants.ts to share logic", ["src/util.ts", "src/constants.ts"]],
      ["Refactor src/constants.ts and helper to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor src/constants.ts and the helper to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor src/constants.ts plus helper to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor src/constants.ts alongside helper to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor src/constants.ts together with the helper to share logic", ["src/constants.ts", "src/util.ts"]],
      ["Refactor src/constants.ts by changing helper", ["src/constants.ts", "src/util.ts"]]
    ] as const) {
      const mixedFocus = await focusBriefQuery(repo, { task, diff: false, limit: 3, tokenBudget: 900 }, { autoRefresh: false });
      expect((mixedFocus.data as { nextCall: { tool: string; arguments?: { files?: string[] } } }).nextCall, task).toMatchObject({
        tool: "change_plan",
        arguments: { files: expectedFiles }
      });
      const mixedSearch = await searchQuery(repo, { query: task, limit: 1 }, { autoRefresh: false });
      expect((mixedSearch.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files, task).toEqual(expectedFiles);
    }

    const ambiguousSymbolTask = "Harden sharedHelper API contract";
    const ambiguousSymbolFocus = await focusBriefQuery(repo, { task: ambiguousSymbolTask, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((ambiguousSymbolFocus.data as { actionability: string; nextCall: { tool: string }; targetCandidates?: string[] })).toMatchObject({
      actionability: "needs_target",
      nextCall: { tool: "search" },
      targetCandidates: ["src/ambiguous-a.ts", "src/ambiguous-b.ts"]
    });
    const ambiguousSymbolSearch = await searchQuery(repo, { query: ambiguousSymbolTask, limit: 6 }, { autoRefresh: false });
    expect((ambiguousSymbolSearch.data as { actionability: string; targetCandidates?: string[]; nextTools?: unknown[] })).toMatchObject({
      actionability: "needs_target",
      targetCandidates: ["src/ambiguous-a.ts", "src/ambiguous-b.ts"],
      nextTools: []
    });
    const caseFoldedAmbiguous = await focusBriefQuery(repo, { task: "Harden sharedhelper API contract", diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((caseFoldedAmbiguous.data as { actionability: string; targetCandidates?: string[] })).toMatchObject({
      actionability: "needs_target",
      targetCandidates: ["src/ambiguous-a.ts", "src/ambiguous-b.ts"]
    });

    for (const task of ["Harden router permissions in src/api.ts", "Harden default API behavior in src/api.ts", "Fix id handling in src/api.ts"]) {
      const incidental = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((incidental.data as { targetCandidates?: string[] }).targetCandidates, task).toEqual([]);
    }

    for (const task of ["Fix sharedHelper API contract in src/ambiguous-a.ts", "Fix sharedHelper API contract in ./src/ambiguous-a.ts"]) {
      const exactSymbolFocus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((exactSymbolFocus.data as { actionability: string; nextCall: { tool: string; arguments?: { files?: string[] } }; targetCandidates?: string[] }), task).toMatchObject({
        actionability: "edit_ready",
        nextCall: { tool: "change_plan", arguments: { files: ["src/ambiguous-a.ts"] } },
        targetCandidates: []
      });
      const exactSymbolSearch = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((exactSymbolSearch.data as { actionability: string; targetCandidates?: string[]; nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }), task).toMatchObject({
        actionability: "edit_ready",
        targetCandidates: []
      });
      expect((exactSymbolSearch.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files, task).toEqual(["src/ambiguous-a.ts"]);
    }

    const structuredDisambiguation = await contextPackQuery(
      repo,
      { task: "Harden sharedHelper", files: ["src/ambiguous-a.ts"], symbols: ["sharedHelper"], changeType: "api", diff: false, includeSnippets: false },
      { autoRefresh: false }
    );
    expect((structuredDisambiguation.data as { actionability: string; targetCandidates?: string[]; nextTools?: Array<{ requiredInputs?: { files?: string[] } }> })).toMatchObject({
      actionability: "edit_ready",
      targetCandidates: [],
      nextTools: [expect.objectContaining({ requiredInputs: expect.objectContaining({ files: ["src/ambiguous-a.ts"] }) })]
    });

    for (const task of ["Harden API permissions in src/missing.ts", "Harden API permissions in src/API.ts", "Harden API permissions in missing.ts", "Harden API permissions in missing.TS", "Harden API permissions in utl.ts", "Harden ./util.ts", "Add permission checks to src/utl.ts", "Write tests for src/utl.ts", "Create auth handling in src/utl.ts", "Create src/utli.ts", "Create src/uitl.ts", "Refactor src/util.ts and src/missing.ts"]) {
      const missingFocus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((missingFocus.data as { actionability: string; nextCall: { tool: string }; unresolvedTargets?: string[] })).toMatchObject({
        actionability: "needs_target",
        nextCall: { tool: "search" }
      });
      expect((missingFocus.data as { unresolvedTargets?: string[] }).unresolvedTargets?.length, task).toBeGreaterThan(0);
      const missingSearch = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((missingSearch.data as { actionability: string; nextTools?: unknown[]; unresolvedTargets?: string[] })).toMatchObject({ actionability: "needs_target", nextTools: [] });
      expect((missingSearch.data as { unresolvedTargets?: string[] }).unresolvedTargets?.length, task).toBeGreaterThan(0);
    }

    for (const task of ["Harden API permissions in util.ts", "Refactor constants.ts and util.ts to share logic"]) {
      const basenameFocus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((basenameFocus.data as { unresolvedTargets?: string[] }).unresolvedTargets, task).toEqual([]);
      expect((basenameFocus.data as { nextCall: { tool: string } }).nextCall.tool, task).toBe("change_plan");
    }

    for (const [task, expectedFiles] of [
      ["Create API endpoint in src/new.ts", ["src/new.ts"]],
      ["Create API endpoint in src/routes.ts", ["src/routes.ts"]],
      ["Implement the new API route in src/routes.ts", ["src/routes.ts"]],
      ["Add new API route at src/routes.ts", ["src/routes.ts"]],
      ["Extract helper into src/helpers.ts", ["src/util.ts", "src/helpers.ts"]],
      ["Extract helper to src/helpers.ts", ["src/util.ts", "src/helpers.ts"]],
      ["Move helper into src/helpers.ts", ["src/util.ts", "src/helpers.ts"]],
      ["Migrate helper into src/helpers.ts", ["src/util.ts", "src/helpers.ts"]],
      ["Rename helper as src/helpers.ts", ["src/util.ts", "src/helpers.ts"]],
      ["Rename src/util.ts to src/helpers/util.ts", ["src/util.ts", "src/helpers/util.ts"]],
      ["Move src/util.ts to src/helpers/util.ts", ["src/util.ts", "src/helpers/util.ts"]],
      ["Migrate src/util.ts to src/helpers/util.ts", ["src/util.ts", "src/helpers/util.ts"]],
      ["Create src/new-api.ts and src/new-worker.ts", ["src/new-api.ts", "src/new-worker.ts"]],
      ["Create src/new-api.ts,src/new-worker.ts", ["src/new-api.ts", "src/new-worker.ts"]],
      ["Add src/foo.ts and src/bar.ts", ["src/foo.ts", "src/bar.ts"]]
    ] as const) {
      const newTargetFocus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((newTargetFocus.data as { unresolvedTargets?: string[] }).unresolvedTargets, task).toEqual([]);
      expect((newTargetFocus.data as { nextCall: { tool: string; arguments?: { files?: string[] } } }).nextCall, task).toMatchObject({
        tool: "change_plan",
        arguments: { files: expectedFiles }
      });
      const newTargetSearch = await searchQuery(repo, { query: task, limit: 6 }, { autoRefresh: false });
      expect((newTargetSearch.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files, task).toEqual(expectedFiles);
    }

    const lowRiskNewTask = "Write the implementation to src/routes.ts";
    const lowRiskNewFocus = await focusBriefQuery(repo, { task: lowRiskNewTask, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((lowRiskNewFocus.data as { actionability: string; unresolvedTargets?: string[]; nextCall: { tool: string } })).toMatchObject({
      actionability: "edit_ready",
      unresolvedTargets: [],
      nextCall: { tool: "source" }
    });
    const lowRiskNewSearch = await searchQuery(repo, { query: lowRiskNewTask, limit: 6 }, { autoRefresh: false });
    expect((lowRiskNewSearch.data as { actionability: string; nextTools?: unknown[]; unresolvedTargets?: string[] })).toMatchObject({
      actionability: "edit_ready",
      nextTools: [],
      unresolvedTargets: []
    });

    const explicitRootCreation = await focusBriefQuery(repo, { task: "Create ./util.ts", diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
    expect((explicitRootCreation.data as { actionability: string; unresolvedTargets?: string[]; nextCall: { tool: string } })).toMatchObject({
      actionability: "edit_ready",
      unresolvedTargets: []
    });
    expect((explicitRootCreation.data as { nextCall: { tool: string } }).nextCall.tool).not.toBe("change_plan");
    const structuredRootCreation = await contextPackQuery(repo, { task: "Create a new file", files: ["./util.ts"], diff: false, includeSnippets: false }, { autoRefresh: false });
    expect((structuredRootCreation.data as { actionability: string; nextTools?: unknown[] })).toMatchObject({ actionability: "edit_ready", nextTools: [] });
    const directRootCreation = await changePlanQuery(repo, { task: "Create a new file", files: ["./util.ts"], diff: false, saveSnapshot: false }, { autoRefresh: false });
    expect((directRootCreation.data as { editReadiness: { editable: boolean }; plannedEditTargets?: string[]; nextTools?: unknown[] })).toMatchObject({
      editReadiness: { editable: true },
      plannedEditTargets: ["util.ts"],
      nextTools: []
    });

    for (const [task, expectedTool] of [["Show callers of helper", "callers"], ["Show callers of `helper`", "callers"], ["Show dependencies of `helper`", "callees"]]) {
      const graphFocus = await focusBriefQuery(repo, { task, diff: false, limit: 6, tokenBudget: 1000 }, { autoRefresh: false });
      expect((graphFocus.data as { nextCall: { tool: string; arguments?: { file?: string } } }).nextCall, task).toMatchObject({ tool: expectedTool, arguments: { file: "src/util.ts" } });
    }

    const lowLimitRisk = await searchQuery(repo, { query: "Harden permissions in src/util.ts", limit: 1 }, { autoRefresh: false });
    expect((lowLimitRisk.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools).toEqual([
      expect.objectContaining({ requiredInputs: expect.objectContaining({ files: ["src/util.ts"] }) })
    ]);

    const graphPathTask = "Refactor src/query/graph.ts and src/query/search.ts to share helper logic";
    const graphPathFocus = await focusBriefQuery(repo, { task: graphPathTask, diff: false, limit: 3, tokenBudget: 900 }, { autoRefresh: false });
    expect((graphPathFocus.data as { nextCall: { tool: string; arguments?: { files?: string[] } } }).nextCall).toMatchObject({
      tool: "change_plan",
      arguments: { files: ["src/query/graph.ts", "src/query/search.ts"] }
    });
    const graphPathSearch = await searchQuery(repo, { query: graphPathTask, limit: 1 }, { autoRefresh: false });
    expect((graphPathSearch.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools).toEqual([
      expect.objectContaining({ requiredInputs: expect.objectContaining({ files: ["src/query/graph.ts", "src/query/search.ts"] }) })
    ]);

    const structuredRisk = await contextPackQuery(
      repo,
      { task: "Create the endpoint", files: ["src/api.ts"], changeType: "api", diff: false, includeSnippets: false, limit: 4, tokenBudget: 900 },
      { autoRefresh: false }
    );
    expect((structuredRisk.data as { actionability: string; packetVerdict: string; nextTools?: Array<{ tool?: string }> })).toMatchObject({
      actionability: "edit_ready",
      packetVerdict: "edit-ready",
      nextTools: [expect.objectContaining({ tool: "change_plan" })]
    });

    const bulkPack = await contextPackQuery(
      repo,
      { task: "Refactor the bulk modules", files: bulkTargets, diff: false, includeSnippets: false, limit: 12, tokenBudget: 1600 },
      { autoRefresh: false }
    );
    expect((bulkPack.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files).toEqual(bulkTargets);

    for (const task of ["Harden API permissions in src/api.ts", "Refactor src/util.ts and src/constants.ts to share logic", "Review changes in src/util.ts"]) {
      const taskPack = await contextPackQuery(repo, { task, diff: false, includeSnippets: false, limit: 8, tokenBudget: 1400 }, { autoRefresh: false });
      const focusPaths = (taskPack.data as { focusFiles: Array<{ file: { path: string } }> }).focusFiles.map((entry) => entry.file.path);
      expect(focusPaths, task).toContain(task.includes("src/api.ts") ? "src/api.ts" : "src/util.ts");
      if (task.startsWith("Refactor")) expect((taskPack.data as { nextTools?: Array<{ requiredInputs?: { files?: string[] } }> }).nextTools?.[0]?.requiredInputs?.files).toEqual(["src/util.ts", "src/constants.ts"]);
      if (task.startsWith("Review")) expect((taskPack.data as { nextTools?: unknown[] }).nextTools).toEqual([]);
    }

    const broadPack = await contextPackQuery(repo, { task: "Update the runtime contract", diff: false, includeSnippets: false, limit: 8, tokenBudget: 1200 }, { autoRefresh: false });
    expect((broadPack.data as { actionability: string; nextTools?: Array<{ tool?: string; requiredInputs?: { query?: string } }> })).toMatchObject({
      actionability: "needs_target",
      nextTools: [expect.objectContaining({ tool: "search", requiredInputs: expect.objectContaining({ query: "Update the runtime contract" }) })]
    });

    const unscopedMaterialPack = await contextPackQuery(repo, { changeType: "api", diff: false, includeSnippets: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((unscopedMaterialPack.data as { actionability: string; nextTools?: unknown[]; systemMessage?: string })).toMatchObject({ actionability: "needs_target", nextTools: [] });
    expect((unscopedMaterialPack.data as { systemMessage?: string }).systemMessage).toContain("concrete task");
  });
});
