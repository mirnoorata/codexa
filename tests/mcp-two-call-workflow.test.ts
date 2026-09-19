import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";

it.each([false, true])("completes the two-call protocol with verification provided=%s and preserves its trust boundary", async verified => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-two-call-"));
  const telemetry = path.join(repo, ".codex/cache/workflow.jsonl");
  await mkdir(path.join(repo, "src")); await mkdir(path.join(repo, "tests"));
  await writeFile(path.join(repo, ".gitignore"), ".codex/\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await writeFile(path.join(repo, "src/counter.js"), "exports.increment = value => value + 1;\n");
  const test = "const { test } = require('node:test'); const assert = require('node:assert/strict'); const { increment } = require('../src/counter'); test('increments', () => assert.equal(increment(1), 2));\n";
  await writeFile(path.join(repo, "tests/counter.test.js"), test);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "CODEXA_MANAGED_POST_EDIT"));
  env.CODEXA_MCP_TELEMETRY_PATH = telemetry;
  const client = new Client({ name: "two-call-consumer", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--tools", "core", "--no-typesafe", "--no-semantic", "--session-memory", "off"], env, stderr: "pipe" }));
    const plan = await client.callTool({ name: "change_plan", arguments: { task: "increment by two", files: ["src/counter.js", "tests/counter.test.js"], saveSnapshot: true, taskId: "two-call", responseFormat: "detailed" } });
    const next = (plan.structuredContent as any).nextTools[0];
    expect(next).toMatchObject({ tool: "capabilities", requiredInputs: { action: "invoke", operation: "post_edit_review", arguments: { taskId: "two-call" } } });
    await writeFile(path.join(repo, "src/counter.js"), "exports.increment = value => value + 2;\n");
    await writeFile(path.join(repo, "tests/counter.test.js"), test.replace("increment(1), 2", "increment(1), 3"));
    let reports: unknown[] = [];
    if (verified) {
      const output = execFileSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
      reports = [{ command: "npm test", status: "passed", exitCode: 0, cwd: repo, outputTail: output }];
    }
    const review = await client.callTool({ name: next.tool, arguments: { ...next.requiredInputs, arguments: { ...next.requiredInputs.arguments, ranCommandReports: reports, responseFormat: "detailed" } } });
    expect(review.isError).not.toBe(true);
    const data = (review.structuredContent as any).data;
    expect(verified ? ["complete"] : ["tests_required", "blocking_inspect"]).toContain(data.completionAuthority);
    expect(data.verificationLedger.some((entry: any) => entry.kind === "test" && entry.status === (verified ? "covered" : "missing"))).toBe(true);
    expect(data.verificationLedger.some((entry: any) => entry.trustTier === "witnessed")).toBe(false);
    await client.close();
    const records = (await readFile(telemetry, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.eventKind === "tool").map(record => record.logicalOperation)).toEqual(["change_plan", "post_edit_review"]);
    expect(records.at(-1)).toMatchObject({ recordKind: "session-complete", eventCount: 2 });
  } finally { await client.close(); await rm(repo, { recursive: true, force: true }); }
}, 30_000);
