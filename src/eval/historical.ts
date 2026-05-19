import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../indexer.js";
import { changePlanQuery, contextPackQuery, focusBriefQuery, impactQuery, postEditReviewQuery, taskBriefQuery, workflowPathQuery } from "../queries.js";
import type { QueryOptions, QueryResult } from "../types.js";
import type { EvalScenario, EvalOracle } from "../eval.js";

type HistoricalTool = "task_brief" | "context_pack" | "focus_brief" | "impact" | "workflow_path" | "change_plan" | "post_edit_review";

interface HistoricalTask {
  id: string;
  suite?: string;
  task: string;
  description?: string;
  tool: HistoricalTool;
  repoFixture?: string;
  setupPatch?: HistoricalSetupPatch[];
  files?: string[];
  symbols?: string[];
  expectedReadFirst: string[];
  expectedChangedFiles?: string[];
  expectedTests?: string[];
  knownTraps?: string[];
  forbiddenFiles?: string[];
  baselineCommands?: string[][];
  expectedCodexaCalls?: string[];
  maxContextChars?: number;
  maxFalsePositiveFiles?: number;
  minFileRecall?: number;
  minChangedFileRecall?: number;
  minTestRecall?: number;
  minFilePrecisionAtK?: number;
}

interface HistoricalSetupPatch {
  path: string;
  content?: string;
  append?: string;
  replace?: Array<{ from: string; to: string }>;
}

interface HistoricalFixtureRepo {
  repoRoot: string;
  tasks: HistoricalTask[];
}

const HISTORICAL_PACK_SCHEMA_VERSION = 1;

export async function historicalFixtureScenarios(seed: string, options: QueryOptions): Promise<EvalScenario[]> {
  const fixture = await createHistoricalFixtureRepo(seed);
  return await Promise.all(fixture.tasks.map((task) => historicalScenario(fixture.repoRoot, options, task, "historical-fixture", undefined, fixture.repoRoot)));
}

export async function externalHistoricalTaskPackScenarios(repoRoot: string, options: QueryOptions, taskPackPath: string): Promise<EvalScenario[]> {
  const tasks = loadExternalHistoricalTaskPack(repoRoot, taskPackPath);
  return await Promise.all(tasks.map((task) => historicalScenario(repoRoot, options, task, "historical-task-pack", taskPackPath)));
}

async function historicalScenario(
  baseRepoRoot: string,
  options: QueryOptions,
  task: HistoricalTask,
  suite: "historical-fixture" | "historical-task-pack",
  taskPackPath?: string,
  sharedCleanupRoot?: string
): Promise<EvalScenario> {
  const prepared = await prepareHistoricalScenarioRepo(baseRepoRoot, task, sharedCleanupRoot);
  const baselineCommand = task.baselineCommands?.[0];
  const expectedCalls = task.expectedCodexaCalls ?? [task.tool];
  const oracle: EvalOracle = {
    expectedFiles: task.expectedReadFirst,
    expectedChangedFiles: task.expectedChangedFiles,
    expectedTests: task.expectedTests,
    forbiddenFiles: task.forbiddenFiles,
    topFiles: task.expectedReadFirst.slice(0, 1),
    knownTraps: task.knownTraps,
    expectedCodexaCalls: expectedCalls,
    maxTextChars: task.maxContextChars,
    maxFalsePositiveFiles: task.maxFalsePositiveFiles ?? 2,
    minFileRecall: task.minFileRecall ?? 0.66,
    minChangedFileRecall: task.minChangedFileRecall ?? (task.expectedChangedFiles?.length ? 1 : undefined),
    minTestRecall: task.minTestRecall ?? (task.expectedTests?.length ? 0.5 : undefined),
    minFilePrecisionAtK: task.minFilePrecisionAtK ?? 0.4,
    maxSelectedToBaselineRatio: baselineCommand ? 2 : undefined
  };
  return {
    id: `${suite}-${task.id}`,
    suite,
    description: task.description ?? task.task,
    repoRoot: prepared.repoRoot,
    baselineCommand,
    baselineCommands: task.baselineCommands,
    codexa: async () => runHistoricalTask(prepared.repoRoot, options, task, expectedCalls),
    oracle,
    privatePack: Boolean(taskPackPath),
    taskPackPath,
    cleanupRepoRoots: prepared.cleanupRepoRoots
  };
}

async function runHistoricalTask(repoRoot: string, options: QueryOptions, task: HistoricalTask, expectedCalls: string[]): Promise<QueryResult> {
  const calls: string[] = [];
  const call = async (name: HistoricalTool, run: () => Promise<QueryResult>) => {
    calls.push(name);
    return await run();
  };
  let result: QueryResult;
  if (task.tool === "impact") {
    result = await call("impact", () => impactQuery(repoRoot, { file: task.files?.[0], symbol: task.symbols?.[0], changeType: "behavior" }, options));
  } else if (task.tool === "workflow_path") {
    result = await call("workflow_path", () => workflowPathQuery(repoRoot, { query: task.task, file: task.files?.[0], symbol: task.symbols?.[0], limit: 10 }, options));
  } else if (task.tool === "context_pack") {
    result = await call("context_pack", () => contextPackQuery(repoRoot, { task: task.task, files: task.files, symbols: task.symbols, diff: false, tokenBudget: 2200, limit: 10 }, options));
  } else if (task.tool === "focus_brief") {
    result = await call("focus_brief", () => focusBriefQuery(repoRoot, { task: task.task, diff: false, tokenBudget: 1600, limit: 8 }, options));
  } else if (task.tool === "change_plan") {
    result = await call("change_plan", () =>
      changePlanQuery(repoRoot, { task: task.task, files: task.files, symbols: task.symbols, changeType: "api", diff: false, tokenBudget: 2200, limit: 8 }, options)
    );
  } else if (task.tool === "post_edit_review") {
    result = await call("change_plan", () =>
      changePlanQuery(repoRoot, {
        task: task.task,
        files: task.files,
        symbols: task.symbols,
        changeType: "api",
        diff: false,
        tokenBudget: 1800,
        limit: 8,
        saveSnapshot: true,
        taskId: `historical-${task.id}-${randomUUID()}`
      }, options)
    );
    const editFile = task.expectedChangedFiles?.[0] ?? task.files?.[0];
    const editPath = editFile ? path.join(repoRoot, editFile) : undefined;
    const originalContent = editPath ? readFileSync(editPath, "utf8") : undefined;
    if (editPath && originalContent !== undefined) {
      await writeFile(editPath, `${originalContent}\n// historical edit marker\n`, "utf8");
    }
    try {
      result = await call("post_edit_review", () => postEditReviewQuery(repoRoot, { taskId: undefined, ranTests: [], tokenBudget: 1800, limit: 8 }, options));
    } finally {
      if (editPath && originalContent !== undefined) {
        await writeFile(editPath, originalContent, "utf8");
      }
    }
  } else {
    result = await call("task_brief", () => taskBriefQuery(repoRoot, { task: task.task, files: task.files, symbols: task.symbols, diff: false, tokenBudget: 2200, limit: 10 }, options));
  }
  return {
    ...result,
    data: {
      ...(result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {}),
      historicalTaskSuite: task.suite,
      repoFixture: task.repoFixture,
      setupPatchFiles: task.setupPatch?.map((entry) => entry.path) ?? [],
      callTrace: calls,
      expectedCallTrace: expectedCalls
    }
  };
}

async function prepareHistoricalScenarioRepo(baseRepoRoot: string, task: HistoricalTask, sharedCleanupRoot?: string): Promise<{ repoRoot: string; cleanupRepoRoots: string[] }> {
  if (!task.setupPatch || task.setupPatch.length === 0) {
    return {
      repoRoot: baseRepoRoot,
      cleanupRepoRoots: sharedCleanupRoot ? [sharedCleanupRoot] : []
    };
  }

  const parent = await mkdtemp(path.join(os.tmpdir(), `codexa-historical-setup-${task.id}-`));
  const repoRoot = path.join(parent, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", baseRepoRoot, repoRoot], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024
    });
    execFileSync("git", ["config", "user.name", "Codexa Eval"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "codexa-eval@example.invalid"], { cwd: repoRoot, stdio: "ignore" });
    await applyHistoricalSetupPatches(repoRoot, task.setupPatch);
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      execFileSync("git", ["commit", "-m", `historical setup ${task.id}`], { cwd: repoRoot, stdio: "ignore" });
    }
    await buildIndex({ repoRoot, writeArtifacts: true });
    return {
      repoRoot,
      cleanupRepoRoots: [parent, ...(sharedCleanupRoot ? [sharedCleanupRoot] : [])]
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function applyHistoricalSetupPatches(repoRoot: string, patches: HistoricalSetupPatch[]): Promise<void> {
  for (const patch of patches) {
    const absolute = path.join(repoRoot, patch.path);
    let text = patch.content;
    if (text === undefined) {
      try {
        text = readFileSync(absolute, "utf8");
      } catch (error) {
        if (patch.append !== undefined) {
          text = "";
        } else {
          throw new Error(`setupPatch target does not exist: ${patch.path}; ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const replacement of patch.replace ?? []) {
      if (!text.includes(replacement.from)) {
        throw new Error(`setupPatch ${patch.path} replacement string was not found`);
      }
      text = text.split(replacement.from).join(replacement.to);
    }
    if (patch.append !== undefined) {
      text = `${text}${patch.append}`;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text, "utf8");
  }
}

function loadExternalHistoricalTaskPack(repoRoot: string, taskPackPath: string): HistoricalTask[] {
  const resolved = path.resolve(taskPackPath);
  if (!existsSync(resolved)) {
    throw new Error(`historical task pack does not exist: ${resolved}`);
  }
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("historical task pack must be a JSON object");
  }
  const pack = parsed as Record<string, unknown>;
  if (pack.schemaVersion !== HISTORICAL_PACK_SCHEMA_VERSION) {
    throw new Error(`historical task pack schemaVersion must be ${HISTORICAL_PACK_SCHEMA_VERSION}`);
  }
  if (typeof pack.packId !== "string" || !pack.packId.trim()) {
    throw new Error("historical task pack requires packId");
  }
  if (typeof pack.repoCommit !== "string" || !pack.repoCommit.trim()) {
    throw new Error("historical task pack requires repoCommit so tasks are anchored to a snapshot");
  }
  const repoCommit = pack.repoCommit.trim();
  const currentCommit = currentGitCommit(repoRoot);
  if (currentCommit !== repoCommit) {
    throw new Error(`historical task pack repoCommit ${repoCommit} does not match target repo HEAD ${currentCommit}`);
  }
  if (!Array.isArray(pack.tasks) || pack.tasks.length === 0) {
    throw new Error("historical task pack requires at least one task");
  }
  const tasks = pack.tasks.map((entry, index) => parseHistoricalTask(entry, `tasks[${index}]`));
  validateTaskCoverage(tasks);
  return tasks;
}

function parseHistoricalTask(value: unknown, label: string): HistoricalTask {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, `${label}.id`);
  const task = requiredString(record.task, `${label}.task`);
  const tool = requiredTool(record.tool, `${label}.tool`);
  const baselineCommands = optionalCommandList(record.baselineCommands, `${label}.baselineCommands`);
  return {
    id,
    suite: optionalString(record.suite),
    task,
    description: optionalString(record.description),
    tool,
    repoFixture: optionalString(record.repoFixture),
    setupPatch: optionalSetupPatchList(record.setupPatch, `${label}.setupPatch`),
    files: optionalRepoPathList(record.files, `${label}.files`),
    symbols: optionalStringList(record.symbols, `${label}.symbols`),
    expectedReadFirst: requiredRepoPathList(record.expectedReadFirst, `${label}.expectedReadFirst`),
    expectedChangedFiles: optionalRepoPathList(record.expectedChangedFiles, `${label}.expectedChangedFiles`),
    expectedTests: optionalRepoPathList(record.expectedTests, `${label}.expectedTests`),
    knownTraps: optionalStringList(record.knownTraps, `${label}.knownTraps`),
    forbiddenFiles: optionalRepoPathList(record.forbiddenFiles, `${label}.forbiddenFiles`),
    baselineCommands,
    expectedCodexaCalls: optionalStringList(record.expectedCodexaCalls, `${label}.expectedCodexaCalls`),
    maxContextChars: optionalNumber(record.maxContextChars, `${label}.maxContextChars`),
    maxFalsePositiveFiles: optionalNumber(record.maxFalsePositiveFiles, `${label}.maxFalsePositiveFiles`),
    minFileRecall: optionalNumber(record.minFileRecall, `${label}.minFileRecall`),
    minChangedFileRecall: optionalNumber(record.minChangedFileRecall, `${label}.minChangedFileRecall`),
    minTestRecall: optionalNumber(record.minTestRecall, `${label}.minTestRecall`),
    minFilePrecisionAtK: optionalNumber(record.minFilePrecisionAtK, `${label}.minFilePrecisionAtK`)
  };
}

function validateTaskCoverage(tasks: HistoricalTask[]): void {
  const tools = new Set(tasks.map((task) => task.tool));
  if (tasks.length < 1) {
    throw new Error("historical task pack must include tasks");
  }
  if (tasks.length >= 5) {
    for (const tool of ["task_brief", "focus_brief", "workflow_path", "change_plan", "post_edit_review"] as HistoricalTool[]) {
      if (!tools.has(tool)) {
        throw new Error(`historical task pack with five or more tasks must include ${tool}`);
      }
    }
  }
}

async function createHistoricalFixtureRepo(seed: string): Promise<HistoricalFixtureRepo> {
  const token = alphaToken(seeded(seed), 8);
  const camel = `${token[0].toUpperCase()}${token.slice(1)}`;
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), `codexa-historical-${token}-`));
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codexa Eval"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codexa-eval@example.invalid"], { cwd: repoRoot, stdio: "ignore" });
  await mkdir(path.join(repoRoot, "src/ui"), { recursive: true });
  await mkdir(path.join(repoRoot, "src/backend"), { recursive: true });
  await mkdir(path.join(repoRoot, "tests"), { recursive: true });
  await mkdir(path.join(repoRoot, "manifests"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repoRoot, "pyproject.toml"), `[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/shared.ts"), `export function normalize${camel}(value: string) {\n  return value.trim().toLowerCase()\n}\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/feature.ts"), `import { normalize${camel} } from "./shared"\nexport function render${camel}(value: string) {\n  return normalize${camel}(value)\n}\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/feature.test.ts"), `import { normalize${camel} } from "./shared"\ntest("${token}", () => expect(normalize${camel}(" A ")).toBe("a"))\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/shared_decoy.ts"), `export function normalize${camel}Decoy(value: string) {\n  return value\n}\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/ui/use_polling.ts"), `import { fetch${camel}Queue } from "./api_client"\nexport function use${camel}Polling() {\n  return fetch${camel}Queue()\n}\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/ui/api_client.ts"), `export function fetch${camel}Queue() {\n  return fetch("/api/${token}/queue")\n}\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/ui/use_polling.test.ts"), `import { use${camel}Polling } from "./use_polling"\ntest("${token}-polling", () => expect(use${camel}Polling).toBeTruthy())\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/backend/store.py"), `def load_${token}_queue():\n    return []\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/backend/routes.py"), `from .store import load_${token}_queue\n\n@router.get("/api/${token}/queue")\ndef ${token}_queue():\n    return load_${token}_queue()\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/backend/helpers.py"), `def prepare_${token}(value):\n    return value.strip().casefold()\n`, "utf8");
  await writeFile(path.join(repoRoot, "src/backend/app.py"), `from .helpers import prepare_${token}\n\n@router.post("/api/${token}/prepare")\ndef prepare_route(value):\n    return prepare_${token}(value)\n`, "utf8");
  await writeFile(path.join(repoRoot, "tests/test_backend.py"), `from src.backend.app import prepare_route\n\ndef test_prepare_route():\n    assert prepare_route(" A ") == "a"\n`, "utf8");
  await writeFile(path.join(repoRoot, "tests/test_queue.py"), `from src.backend.routes import ${token}_queue\n\ndef test_queue_route():\n    assert ${token}_queue() == []\n`, "utf8");
  await writeFile(path.join(repoRoot, `manifests/${token}.json`), JSON.stringify({ nodes: [{ type_id: `${token}.node`, adapter_key: `${token}.adapter` }] }, null, 2), "utf8");
  await writeFile(path.join(repoRoot, "src/backend/adapter.py"), `NODE_TYPE = "${token}.node"\ndef run_${token}_adapter():\n    return NODE_TYPE\n`, "utf8");
  await writeFile(path.join(repoRoot, "tests/test_adapter.py"), `from src.backend.adapter import run_${token}_adapter\n\ndef test_adapter():\n    assert run_${token}_adapter() == "${token}.node"\n`, "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "historical benchmark fixture"], { cwd: repoRoot, stdio: "ignore" });
  await buildIndex({ repoRoot, writeArtifacts: true });

  const tasks: HistoricalTask[] = [
    {
      id: "exact-shared-api",
      suite: "typescript-api",
      repoFixture: "seeded-typescript-python-service",
      task: `Refactor normalize${camel} API without missing consumers`,
      tool: "change_plan",
      files: ["src/shared.ts"],
      expectedReadFirst: ["src/shared.ts", "src/feature.test.ts", "src/feature.ts"],
      expectedChangedFiles: ["src/shared.ts"],
      expectedTests: ["src/feature.test.ts"],
      forbiddenFiles: ["src/shared_decoy.ts"],
      knownTraps: ["similarly named decoy helper"],
      baselineCommands: [["rg", "-n", `normalize${camel}`, "."]],
      expectedCodexaCalls: ["change_plan"],
      maxFalsePositiveFiles: 1
    },
    {
      id: "broad-workflow",
      suite: "workflow",
      repoFixture: "seeded-typescript-python-service",
      task: `${token} queue polling from UI to backend route store and tests`,
      tool: "workflow_path",
      expectedReadFirst: ["src/backend/routes.py", "src/ui/api_client.ts", "src/backend/store.py", "src/ui/use_polling.ts"],
      expectedTests: ["src/ui/use_polling.test.ts", "tests/test_queue.py"],
      baselineCommands: [["rg", "-n", `${token}|queue|polling|/api/${token}/queue`, "."]],
      expectedCodexaCalls: ["workflow_path"],
      maxFalsePositiveFiles: 0,
      minFileRecall: 1,
      minTestRecall: 0.5
    },
    {
      id: "python-route-helper",
      suite: "python-api",
      repoFixture: "seeded-typescript-python-service",
      task: `Change prepare_${token} helper and keep route tests in scope`,
      tool: "impact",
      files: ["src/backend/helpers.py"],
      expectedReadFirst: ["src/backend/helpers.py", "src/backend/app.py"],
      expectedTests: ["tests/test_backend.py"],
      baselineCommands: [["rg", "-n", `prepare_${token}`, "."]],
      expectedCodexaCalls: ["impact"],
      maxFalsePositiveFiles: 1
    },
    {
      id: "manifest-adapter",
      suite: "manifest-adapter",
      repoFixture: "seeded-typescript-python-service",
      task: `Change ${token}.node manifest behavior and find adapter tests`,
      tool: "context_pack",
      files: [`manifests/${token}.json`],
      expectedReadFirst: [`manifests/${token}.json`, "src/backend/adapter.py"],
      expectedTests: ["tests/test_adapter.py"],
      baselineCommands: [["rg", "-n", `${token}.node`, "."]],
      expectedCodexaCalls: ["context_pack"],
      maxFalsePositiveFiles: 0,
      minFileRecall: 1,
      minTestRecall: 0
    },
    {
      id: "post-edit-drift",
      suite: "post-edit",
      repoFixture: "seeded-typescript-python-service",
      task: `Edit normalize${camel} and verify planned drift before finishing`,
      tool: "post_edit_review",
      files: ["src/shared.ts"],
      expectedReadFirst: ["src/shared.ts", "src/feature.test.ts", "src/feature.ts"],
      expectedChangedFiles: ["src/shared.ts"],
      expectedTests: ["src/feature.test.ts"],
      forbiddenFiles: ["src/shared_decoy.ts"],
      baselineCommands: [["rg", "-n", `normalize${camel}`, "."]],
      expectedCodexaCalls: ["change_plan", "post_edit_review"],
      maxFalsePositiveFiles: 1,
      maxContextChars: 7200
    }
  ];
  return { repoRoot, tasks };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredTool(value: unknown, label: string): HistoricalTool {
  const tool = requiredString(value, label);
  if (!["task_brief", "context_pack", "focus_brief", "impact", "workflow_path", "change_plan", "post_edit_review"].includes(tool)) {
    throw new Error(`${label} is not a supported historical Codexa tool`);
  }
  return tool as HistoricalTool;
}

function requiredStringList(value: unknown, label: string): string[] {
  const values = optionalStringList(value, label);
  if (!values || values.length === 0) {
    throw new Error(`${label} must include at least one string`);
  }
  return values;
}

function optionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function requiredRepoPathList(value: unknown, label: string): string[] {
  return validateRepoPathList(requiredStringList(value, label), label);
}

function optionalRepoPathList(value: unknown, label: string): string[] | undefined {
  const values = optionalStringList(value, label);
  return values ? validateRepoPathList(values, label) : undefined;
}

function validateRepoPathList(values: string[], label: string): string[] {
  for (const value of values) {
    if (isUnsafeRepoRelativePath(value)) {
      throw new Error(`${label} contains unsafe repo-relative path: ${value}`);
    }
  }
  return values;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalCommandList(value: unknown, label: string): string[][] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of command arrays`);
  }
  return value.map((entry, index) => {
    const command = requiredStringList(entry, `${label}[${index}]`);
    assertAllowedHistoricalBaseline(command, `${label}[${index}]`);
    return command;
  });
}

function optionalSetupPatchList(value: unknown, label: string): HistoricalSetupPatch[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of setup patch objects`);
  }
  return value.map((entry, index) => parseSetupPatch(entry, `${label}[${index}]`));
}

function parseSetupPatch(value: unknown, label: string): HistoricalSetupPatch {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const patchPath = requiredString(record.path, `${label}.path`);
  validateRepoPathList([patchPath], `${label}.path`);
  const content = record.content === undefined ? undefined : requiredPatchText(record.content, `${label}.content`);
  const append = record.append === undefined ? undefined : requiredPatchText(record.append, `${label}.append`);
  const replace = optionalReplacementList(record.replace, `${label}.replace`);
  if (content === undefined && append === undefined && (!replace || replace.length === 0)) {
    throw new Error(`${label} must include content, append, or replace`);
  }
  return { path: patchPath, content, append, replace };
}

function requiredPatchText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function optionalReplacementList(value: unknown, label: string): Array<{ from: string; to: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of replacement objects`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      from: requiredString(record.from, `${label}[${index}].from`),
      to: requiredPatchText(record.to, `${label}[${index}].to`)
    };
  });
}

function assertAllowedHistoricalBaseline(command: string[], label: string): void {
  const executable = command[0];
  for (const arg of command) {
    if (isUnsafeBaselineArgument(arg)) {
      throw new Error(`${label} contains unsafe baseline argument: ${arg}`);
    }
  }
  if (executable === "rg" && isAllowedRipgrepBaseline(command.slice(1))) {
    return;
  }
  if (isAllowedGitStatusBaseline(command) || isAllowedGitGrepBaseline(command)) {
    return;
  }
  throw new Error(`${label} uses unsupported baseline executable: ${executable}`);
}

function currentGitCommit(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    throw new Error(`historical task pack target repo must be a git repository with a HEAD commit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isAllowedGitStatusBaseline(command: string[]): boolean {
  return command[0] === "git" && command[1] === "status" && command.length === 3 && (command[2] === "--short" || command[2] === "--porcelain");
}

function isAllowedGitGrepBaseline(command: string[]): boolean {
  if (command[0] !== "git" || command[1] !== "grep") {
    return false;
  }
  const allowedFlags = new Set(["-n", "--line-number", "-E", "-F", "-e", "-m", "--"]);
  for (let i = 2; i < command.length; i += 1) {
    const arg = command[i];
    if (command[i - 1] === "-e" || command[i - 1] === "-m") {
      continue;
    }
    if (arg.startsWith("-") && !allowedFlags.has(arg)) {
      return false;
    }
  }
  return true;
}

function isAllowedRipgrepBaseline(args: string[]): boolean {
  let pattern: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-n" || arg === "--line-number" || arg === "--") {
      continue;
    }
    if (arg === "-e") {
      if (!args[index + 1]) {
        return false;
      }
      pattern = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return false;
    }
    pattern ??= arg;
  }
  return Boolean(pattern);
}

function isUnsafeRepoRelativePath(value: string): boolean {
  if (path.isAbsolute(value) || value === "." || value === "") {
    return true;
  }
  return value.split(/[\\/]+/).some((part) => part === ".." || part === "");
}

function isUnsafeBaselineArgument(value: string): boolean {
  if (value === ".") {
    return false;
  }
  return path.isAbsolute(value) || value === ".codex" || value.includes(".codex/") || value.includes(".codex\\") || value.includes("../") || value.includes("..\\");
}

function seeded(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 0xffffffff;
  };
}

function alphaToken(rng: () => number, length: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += letters[Math.floor(rng() * letters.length) % letters.length];
  }
  return value;
}
