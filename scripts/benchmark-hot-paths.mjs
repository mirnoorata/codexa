#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.repo ?? process.cwd());
const cli = path.join(repoRoot, "dist", "cli.js");
const iterations = args.runs ?? 5;
const warmups = args.warmups ?? 1;
const outputPath = args.output ? path.resolve(args.output) : undefined;
const summaryPath = args.summary ? path.resolve(args.summary) : process.env.GITHUB_STEP_SUMMARY;

if (!existsSync(cli)) {
  throw new Error("dist/cli.js is missing. Run `npm run build` before benchmark-hot-paths.");
}

const benchmark = {
  schemaVersion: 1,
  repoRoot,
  createdAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  iterations,
  warmups,
  metrics: [],
  artifacts: []
};

const indexRun = timeCommand("index", [process.execPath, cli, "index", repoRoot], { timeoutMs: 60_000 });
benchmark.metrics.push(singleMetric("cli.index", indexRun.durationMs, 30_000));
recordArtifact("index.json", ".codex/codebase/index.json");
recordArtifact("facts.ndjson", ".codex/codebase/facts.ndjson");
recordArtifact("repo-map.md", ".codex/codebase/repo-map.md");

benchmark.metrics.push(
  runCliBenchmark("cli.status", ["status", repoRoot], 2_000),
  runCliBenchmark("cli.repo_map", ["repo-map", repoRoot, "--no-auto-refresh", "--budget", "1200", "--limit", "10"], 3_000),
  runCliBenchmark(
    "cli.brief_explicit_file",
    ["brief", repoRoot, "--task", "Tighten package smoke benchmark workflow", "--file", "scripts/benchmark-hot-paths.mjs", "--no-auto-refresh", "--no-snippets", "--budget", "1600", "--limit", "6"],
    4_000
  ),
  runCliBenchmark(
    "cli.brief_task_only",
    ["brief", repoRoot, "--task", "Add CI package install smoke and hot path benchmark coverage", "--no-auto-refresh", "--no-snippets", "--budget", "1600", "--limit", "6"],
    6_000
  )
);

timeCommand("hook-post-edit warmup", [process.execPath, cli, "hook-post-edit", repoRoot], { timeoutMs: 30_000 });
benchmark.metrics.push(runCliBenchmark("cli.hook_post_edit_cached", ["hook-post-edit", repoRoot], 4_000));
benchmark.metrics.push(...(await runMcpBenchmarks()));

const failures = benchmark.metrics.filter((metric) => !metric.passed);
const text = renderSummary(benchmark, failures);
if (outputPath) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
}
if (summaryPath) {
  appendFileSync(summaryPath, `${text}\n`, "utf8");
}
console.log(text);
if (failures.length > 0 && !args.warnOnly) {
  process.exitCode = 1;
}

function runCliBenchmark(name, cliArgs, thresholdMs) {
  const measurements = [];
  for (let i = 0; i < warmups + iterations; i += 1) {
    const measurement = timeCommand(name, [process.execPath, cli, ...cliArgs], { timeoutMs: Math.max(20_000, thresholdMs * 4) });
    if (i >= warmups) {
      measurements.push(measurement.durationMs);
    }
  }
  return measurementMetric(name, "cli", measurements, thresholdMs);
}

async function runMcpBenchmarks() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", repoRoot, "--no-auto-refresh"],
    stderr: "pipe"
  });
  const client = new Client({ name: "codexa-hot-path-benchmark", version: "0.1.0" });
  const startupStarted = process.hrtime.bigint();
  const metrics = [];
  try {
    await withTimeout(client.connect(transport), 15_000, "MCP connect timed out");
    const startupMs = elapsedMs(startupStarted);
    metrics.push(singleMetric("mcp.startup", startupMs, 5_000, "mcp"));
    await withTimeout(client.listTools(), 15_000, "MCP listTools timed out");
    metrics.push(
      await runMcpToolBenchmark(client, "mcp.freshness", "freshness", {}, 500),
      await runMcpToolBenchmark(client, "mcp.repo_map", "repo_map", { limit: 10, tokenBudget: 1200 }, 1_500),
      await runMcpToolBenchmark(
        client,
        "mcp.task_brief_explicit_file",
        "task_brief",
        {
          task: "Tighten package smoke benchmark workflow",
          files: ["scripts/benchmark-hot-paths.mjs"],
          tokenBudget: 1600,
          limit: 6,
          includeSnippets: false
        },
        2_000
      )
    );
  } finally {
    await client.close().catch(() => undefined);
  }
  return metrics;
}

async function runMcpToolBenchmark(client, metricName, toolName, toolArgs, thresholdMs) {
  const measurements = [];
  for (let i = 0; i < warmups + iterations; i += 1) {
    const startedAt = process.hrtime.bigint();
    await withTimeout(client.callTool({ name: toolName, arguments: toolArgs }), Math.max(15_000, thresholdMs * 4), `${metricName} timed out`);
    if (i >= warmups) {
      measurements.push(elapsedMs(startedAt));
    }
  }
  return measurementMetric(metricName, "mcp", measurements, thresholdMs);
}

function timeCommand(label, commandLine, options = {}) {
  const [command, ...commandArgs] = commandLine;
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = elapsedMs(startedAt);
  if (result.error) {
    throw new Error(`${label} failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}\nstdout:\n${bound(result.stdout)}\nstderr:\n${bound(result.stderr)}`);
  }
  return { durationMs, stdout: result.stdout, stderr: result.stderr };
}

function measurementMetric(name, kind, measurements, thresholdMs) {
  const sorted = [...measurements].sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);
  return {
    name,
    kind,
    measurementsMs: measurements.map((measurement) => Math.round(measurement)),
    minMs: Math.round(sorted[0] ?? 0),
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(p95),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
    avgMs: Math.round(measurements.reduce((sum, measurement) => sum + measurement, 0) / Math.max(1, measurements.length)),
    thresholdMs,
    passed: p95 <= thresholdMs
  };
}

function singleMetric(name, durationMs, thresholdMs, kind = "cli") {
  return {
    name,
    kind,
    measurementsMs: [Math.round(durationMs)],
    minMs: Math.round(durationMs),
    p50Ms: Math.round(durationMs),
    p95Ms: Math.round(durationMs),
    maxMs: Math.round(durationMs),
    avgMs: Math.round(durationMs),
    thresholdMs,
    passed: durationMs <= thresholdMs
  };
}

function percentile(sorted, percentileValue) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function recordArtifact(label, relativePath) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    benchmark.artifacts.push({ label, path: relativePath, present: false });
    return;
  }
  const stat = statSync(absolute);
  benchmark.artifacts.push({ label, path: relativePath, present: true, bytes: stat.size });
}

function renderSummary(result, failures) {
  const lines = [
    "## Codexa Hot Path Benchmark",
    "",
    `Node: \`${result.node}\``,
    `Platform: \`${result.platform}\``,
    `Iterations: \`${result.iterations}\` after \`${result.warmups}\` warmup run(s)`,
    "",
    "| Metric | p50 ms | p95 ms | Threshold ms | Result |",
    "| --- | ---: | ---: | ---: | --- |"
  ];
  for (const metric of result.metrics) {
    lines.push(`| \`${metric.name}\` | ${metric.p50Ms} | ${metric.p95Ms} | ${metric.thresholdMs} | ${metric.passed ? "pass" : "fail"} |`);
  }
  lines.push("", "| Artifact | Size |", "| --- | ---: |");
  for (const artifact of result.artifacts) {
    lines.push(`| \`${artifact.path}\` | ${artifact.present ? formatBytes(artifact.bytes) : "missing"} |`);
  }
  if (failures.length > 0) {
    lines.push("", `Benchmark failed: ${failures.map((metric) => metric.name).join(", ")}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      parsed.repo = requireValue(argv, ++i, arg);
    } else if (arg === "--runs") {
      parsed.runs = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--warmups") {
      parsed.warmups = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--output") {
      parsed.output = requireValue(argv, ++i, arg);
    } else if (arg === "--summary") {
      parsed.summary = requireValue(argv, ++i, arg);
    } else if (arg === "--warn-only") {
      parsed.warnOnly = true;
    } else {
      throw new Error(`Unknown benchmark option: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function bound(text, max = 2000) {
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}
