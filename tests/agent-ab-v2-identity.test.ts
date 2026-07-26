import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error the benchmark analyzer is intentionally plain ESM
import { analyzeAgentAbRouteConformance } from "../scripts/agent-ab-analysis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "agent-ab.mjs");
const benchmarkRoot = path.join(root, "benchmarks", "agent-ab");
const mcpPreflight = path.join(benchmarkRoot, "support", "mcp-initialize-tools-list-smoke.mjs");
const armIds = ["control", "full-detailed-legacy", "adaptive-auto-legacy", "adaptive-auto-bounded"] as const;
const comparisons = [
  { id: "optimized-net-value", baselineArm: "control", candidateArm: "adaptive-auto-bounded", primary: true },
  { id: "total-optimization", baselineArm: "full-detailed-legacy", candidateArm: "adaptive-auto-bounded", primary: false },
  { id: "transport-exposure", baselineArm: "full-detailed-legacy", candidateArm: "adaptive-auto-legacy", primary: false },
  { id: "cadence", baselineArm: "adaptive-auto-legacy", candidateArm: "adaptive-auto-bounded", primary: false }
] as const;

describe("agent A/B schema-v2 candidate identity", () => {
  it("rejects invalid route classes while accepting legacy schema-v2 tasks without the additive field", async () => {
    const fixture = await createV2Benchmark(true);
    const value = JSON.parse(await readFile(fixture.config, "utf8"));
    value.tasks[0].expectedRouteClass = "call-everything";
    await writeFile(fixture.config, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const result = run(["validate", "--config", fixture.config]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expectedRouteClass must be one of");
    delete value.tasks[0].expectedRouteClass;
    await writeFile(fixture.config, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    expect(run(["validate", "--config", fixture.config]).status).toBe(0);
  });

  it("preflights registered MCP arms without invoking Harbor or starting attempts", async () => {
    const fixture = await createV2Benchmark(true);
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-command-"));
    const registered = run([
      "register", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ]);
    expect(registered.status).toBe(0);
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-bin-"));
    const uvxMarker = path.join(output, "uvx-must-not-run");
    await writeExecutable(path.join(fakeBin, "uvx"), `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_UVX_MARKER, "invoked\\n");
process.exit(99);
`);
    await writeExecutable(path.join(fakeBin, "docker"), `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "build" || (args[0] === "image" && args[1] === "rm")) process.exit(0);
if (args[0] !== "run") process.exit(2);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "codexa", version: "0.10.0" } } }) + "\\n");
  if (message.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search" }] } }) + "\\n");
});
`);
    const result = run([
      "preflight", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_UVX_MARKER: uvxMarker
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 2, status: "passed", registeredRuns: 4 });
    expect((await readdir(path.join(output, "preflight"))).filter((entry) => entry.endsWith(".json"))).toHaveLength(3);
    await expect(readFile(uvxMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of ["attempts", "runs", "jobs"]) {
      await expect(readdir(path.join(output, directory))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses to backfill a missing identity receipt after an attempt journal exists", async () => {
    const fixture = await createV2Benchmark(true);
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-backfill-"));
    const registered = run([
      "register", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ]);
    expect(registered.status).toBe(0);
    const registration = JSON.parse(registered.stdout);
    const started = registration.assignments.find((assignment: { arm: string }) => assignment.arm === "full-detailed-legacy");
    await mkdir(path.join(output, "attempts"));
    await writeFile(
      path.join(output, "attempts", `${started.runId}.json`),
      `${JSON.stringify(attemptJournal(registration, started, "2026-07-25T00:00:00.000Z"), null, 2)}\n`,
      "utf8"
    );
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-backfill-bin-"));
    const dockerMarker = path.join(output, "docker-must-not-run");
    await writeExecutable(path.join(fakeBin, "docker"), `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_DOCKER_MARKER, "invoked\\n");
process.exit(99);
`);
    const result = run([
      "preflight", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_MARKER: dockerMarker
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("instead of backfilling identity proof");
    await expect(readFile(dockerMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an identity receipt created after the first bound attempt", async () => {
    const fixture = await createV2Benchmark(true);
    const output = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-late-"));
    const registered = run([
      "register", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ]);
    expect(registered.status).toBe(0);
    const registration = JSON.parse(registered.stdout);
    const started = registration.assignments.find((assignment: { arm: string }) => assignment.arm === "full-detailed-legacy");
    const arm = registration.arms.find((entry: { id: string }) => entry.id === started.arm);
    const task = registration.tasks.find((entry: { id: string }) => entry.id === started.taskId);
    await mkdir(path.join(output, "attempts"));
    await mkdir(path.join(output, "preflight"));
    await writeFile(
      path.join(output, "attempts", `${started.runId}.json`),
      `${JSON.stringify(attemptJournal(registration, started, "2026-07-25T00:00:00.000Z"), null, 2)}\n`,
      "utf8"
    );
    const commandHash = createHash("sha256").update(arm.serverCommand).digest("hex").slice(0, 24);
    await writeFile(
      path.join(output, "preflight", `${task.id}-${commandHash}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "schema-v2-mcp-preflight",
        experimentId: registration.experimentId,
        configHash: registration.configHash,
        taskId: task.id,
        taskHash: task.hash,
        serverCommand: arm.serverCommand,
        expectedServerInfo: { name: "codexa", version: registration.candidate.codexaVersion },
        mcpPreflightHash: registration.harness.mcpPreflightHash,
        observedServerInfo: { name: "codexa", version: registration.candidate.codexaVersion },
        completedAt: "2026-07-25T00:00:01.000Z"
      }, null, 2)}\n`,
      "utf8"
    );
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-preflight-late-bin-"));
    const dockerMarker = path.join(output, "docker-must-not-run");
    await writeExecutable(path.join(fakeBin, "docker"), `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_DOCKER_MARKER, "invoked\\n");
process.exit(99);
`);
    const result = run([
      "preflight", "--config", fixture.config, "--output", output,
      "--agent", "codex", "--model", "openai/example-model"
    ], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_MARKER: dockerMarker
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("completed after an attempt journal started");
    await expect(readFile(dockerMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives zero, direct, and dispatcher route patterns while failing ambiguous lineage closed", () => {
    const call = (id: string, tool: string, argumentsValue: Record<string, unknown> = {}) => ({
      tool_call_id: id,
      function_name: `mcp__codexa__${tool}`,
      arguments: argumentsValue
    });
    const cases = [
      ["source-only", [], []],
      ["search-only", [call("search", "search")], ["search"]],
      ["plan-review", [
        call("plan", "change_plan"),
        call("review", "capabilities", { action: "invoke", operation: "post_edit_review", arguments: {} })
      ], ["change_plan", "post_edit_review"]],
      ["search-plan-review", [
        call("search-risk", "search"),
        call("plan-risk", "change_plan"),
        call("review-risk", "capabilities", { action: "invoke", operation: "post_edit_review", arguments: {} })
      ], ["search", "change_plan", "post_edit_review"]]
    ] as const;
    for (const [expectedRouteClass, tool_calls, expectedOperations] of cases) {
      const result = analyzeAgentAbRouteConformance({
        expectedRouteClass,
        trajectory: { schema_version: "ATIF-v1.7", steps: tool_calls.length > 0 ? [{ tool_calls }] : [] }
      });
      expect(result.routeTrace).toMatchObject({ status: "observed", logicalOperations: expectedOperations });
      expect(result.routeConformance).toMatchObject({
        status: "match",
        expectedRouteClass,
        actualOperations: expectedOperations
      });
    }
    const duplicate = call("duplicate", "search");
    const partial = analyzeAgentAbRouteConformance({
      expectedRouteClass: "search-only",
      trajectory: { schema_version: "ATIF-v1.7", steps: [{ tool_calls: [duplicate, duplicate] }] }
    });
    expect(partial.routeTrace.status).toBe("partial");
    expect(partial.routeConformance.status).toBe("unknown");
    for (const malformedMarker of ["true", 1]) {
      const malformed = analyzeAgentAbRouteConformance({
        expectedRouteClass: "search-only",
        trajectory: {
          schema_version: "ATIF-v1.7",
          steps: [{ is_copied_context: malformedMarker, tool_calls: [call("malformed-copy", "search")] }]
        }
      });
      expect(malformed.routeTrace.status).toBe("partial");
      expect(malformed.routeConformance.status).toBe("unknown");
    }
    for (const argumentsValue of [
      { input: "// tools.mcp__codexa__search({}); tools.mcp__codexa__change_plan({});" },
      { cmd: "false && codexa search --query ignored" }
    ]) {
      const ambiguous = analyzeAgentAbRouteConformance({
        expectedRouteClass: "source-only",
        trajectory: {
          schema_version: "ATIF-v1.7",
          steps: [{ tool_calls: [{ tool_call_id: "outer-exec", function_name: "exec", arguments: argumentsValue }] }]
        }
      });
      expect(ambiguous.routeTrace.status).toBe("partial");
      expect(ambiguous.routeConformance.status).toBe("unknown");
    }
  });

  it("rejects unprovisioned commands and unbound installs, then identity-checks initialize plus tools/list", async () => {
    const unprovisioned = await createV2Benchmark(false);
    const rejected = run(["validate", "--config", unprovisioned.config]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("does not provision registered arm command");

    const unboundInstall = await createV2Benchmark(true);
    const dockerfilePath = path.join(
      unboundInstall.root,
      "tasks",
      "path-target-normalization",
      "environment",
      "Dockerfile"
    );
    const dockerfile = await readFile(dockerfilePath, "utf8");
    await writeFile(
      dockerfilePath,
      dockerfile.replace('@mirnoorata/codexa@${CODEXA_VERSION}', "@mirnoorata/codexa@0.10.0"),
      "utf8"
    );
    const unboundResult = run(["validate", "--config", unboundInstall.config]);
    expect(unboundResult.status).toBe(1);
    expect(unboundResult.stderr).toContain("must install @mirnoorata/codexa from ${CODEXA_VERSION}");

    const fakeRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-mcp-preflight-"));
    const fakeServer = path.join(fakeRoot, "fake-mcp.mjs");
    const methodLog = path.join(fakeRoot, "methods.jsonl");
    await writeFile(fakeServer, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  appendFileSync(process.env.MCP_METHOD_LOG, String(message.method) + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "codexa", version: "0.10.0" } } }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "task_brief" }] } }) + "\\n");
  }
}
`, "utf8");
    await chmod(fakeServer, 0o755);
    const identityResult = path.join(fakeRoot, "identity.json");
    const preflight = spawnSync(process.execPath, [
      mcpPreflight,
      "--expected-version",
      "0.10.0",
      "--result",
      identityResult,
      "--",
      process.execPath,
      fakeServer
    ], {
      cwd: root,
      env: { ...process.env, MCP_METHOD_LOG: methodLog },
      encoding: "utf8"
    });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(JSON.parse(await readFile(identityResult, "utf8"))).toEqual({
      schemaVersion: 1,
      expectedServerInfo: { name: "codexa", version: "0.10.0" },
      observedServerInfo: { name: "codexa", version: "0.10.0" }
    });
    expect((await readFile(methodLog, "utf8")).trim().split("\n")).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list"
    ]);

    const wrongIdentityResult = path.join(fakeRoot, "wrong-identity.json");
    const wrongBinary = spawnSync(process.execPath, [
      mcpPreflight,
      "--expected-version",
      "0.10.1",
      "--result",
      wrongIdentityResult,
      "--",
      process.execPath,
      fakeServer
    ], {
      cwd: root,
      env: { ...process.env, MCP_METHOD_LOG: methodLog },
      encoding: "utf8"
    });
    expect(wrongBinary.status).toBe(1);
    expect(wrongBinary.stderr).toContain("initialize serverInfo did not identify codexa@0.10.1");
    await expect(readFile(wrongIdentityResult, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function run(args: string[], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: "utf8" });
}

async function writeExecutable(file: string, contents: string) {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}

function attemptJournal(registration: Record<string, unknown>, assignment: Record<string, unknown>, startedAt: string) {
  return {
    schemaVersion: 1,
    experimentId: registration.experimentId,
    configHash: registration.configHash,
    agent: registration.agent,
    model: registration.model,
    harness: registration.harness,
    runner: registration.runner,
    runId: assignment.runId,
    taskId: assignment.taskId,
    taskName: assignment.taskName,
    repetition: assignment.repetition,
    arm: assignment.arm,
    order: assignment.order,
    jobName: assignment.jobName,
    startedAt
  };
}

async function createV2Benchmark(provisionCommands: boolean) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codexa-agent-ab-v2-identity-config-"));
  const target = path.join(parent, "agent-ab");
  await cp(benchmarkRoot, target, { recursive: true });
  const original = JSON.parse(await readFile(path.join(target, "experiment.json"), "utf8"));
  const arms = armIds.map((id) => id === "control"
    ? { id, kind: "control" }
    : {
        id,
        kind: "codexa",
        mcpConfig: `config/${id}.mcp.json`,
        extraInstruction: `config/${id}-instructions.md`
      });
  for (const id of armIds.slice(1)) {
    await writeFile(
      path.join(target, "config", `${id}.mcp.json`),
      `${JSON.stringify({ mcpServers: { codexa: { command: `/opt/codexa-agent-ab/start-codexa-mcp-${id}`, args: [] } } }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(target, "config", `${id}-instructions.md`), `Use Codexa for registered arm ${id}.\n`, "utf8");
  }
  for (const task of original.tasks) {
    const environment = path.join(target, task.path, "environment");
    const dockerfilePath = path.join(environment, "Dockerfile");
    let dockerfile = await readFile(dockerfilePath, "utf8");
    if (provisionCommands) {
      for (const id of armIds.slice(1)) {
        const basename = `start-codexa-mcp-${id}`;
        await writeFile(path.join(environment, `${basename}.sh`), `#!/usr/bin/env bash
set -euo pipefail
repo=/workspace/project
codexa=/opt/codexa-runtime/bin/codexa
exec "$codexa" serve "$repo"
`, "utf8");
        dockerfile += `COPY --chmod=0755 ${basename}.sh /opt/codexa-agent-ab/${basename}\n`;
      }
    }
    await writeFile(dockerfilePath, dockerfile, "utf8");
  }
  const config = path.join(target, "experiment-v2.json");
  await writeFile(config, `${JSON.stringify({
    schemaVersion: 2,
    experimentId: "codexa-agent-ab-stepped-v2-identity-test",
    framework: original.framework,
    runner: original.runner,
    candidate: original.candidate,
    design: { ...original.design, repetitions: 1 },
    tasks: original.tasks.map((task: Record<string, unknown>) => ({
      ...task,
      expectedRouteClass: "source-only"
    })),
    arms,
    analysis: { ...original.analysis, comparisons }
  }, null, 2)}\n`, "utf8");
  return { root: target, config };
}
