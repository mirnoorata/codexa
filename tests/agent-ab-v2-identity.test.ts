import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env: process.env, encoding: "utf8" });
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
    tasks: original.tasks,
    arms,
    analysis: { ...original.analysis, comparisons }
  }, null, 2)}\n`, "utf8");
  return { root: target, config };
}
