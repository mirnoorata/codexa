#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8");
const inventory = JSON.parse(await readText("docs/plans/codexa-startup-context-inventory.json"));
const projectKernel = await readText("AGENTS.md");
const packageJson = JSON.parse(await readText("package.json"));
const plan = await readText("docs/plans/codexa-startup-optimization-2026-07-23.md");
const readme = await readText("README.md");
const { CORE_PROFILE_TOOL_NAMES, MCP_TOOL_NAMES } = await import("../dist/mcp-tool-catalog.js");
const {
  initializeProject,
  SESSION_START_JSON_MAX_BYTES,
  sessionStartSummary
} = await import("../dist/init.js");

assert.equal(inventory.schemaVersion, 1);
assert.equal(inventory.kind, "codexa-startup-context-inventory");
assert.match(inventory.claimBoundary, /not model tokens/i);
assert.equal(inventory.baselineObservation.platformEnvelope.repoControllable, false);
assert.equal(inventory.currentDesign.freshDesktopWorktreeEvaluation.status, "pending-user-authorized-three-arm-measurement");
assert.equal(
  inventory.baselineObservation.session.postFocusInputTokens - inventory.baselineObservation.session.preFocusInputTokens,
  inventory.baselineObservation.session.focusPromptIncrementInputTokens
);
assert.equal(
  inventory.baselineObservation.session.postFocusInputTokens - inventory.baselineObservation.platformEnvelope.firstCallInputTokens,
  inventory.baselineObservation.session.postFirstCallCumulativeInputTokens
);

const policy = inventory.currentDesign.automaticPolicySnapshot;
assert.equal(
  policy.totalBytes,
  policy.hostKernelBytes + policy.workspaceKernelBytes + policy.projectKernelBytes,
  "automatic-policy snapshot must add up"
);
assert.equal(policy.fourBytesPerTokenEstimate, Math.ceil(policy.totalBytes / 4));
assert.equal(
  policy.reductionPercent,
  roundedReduction(inventory.baselineObservation.automaticPolicyBytes, policy.totalBytes)
);
assert.equal(policy.externalSnapshotsReproducibleInRepository, false);
assert.equal(Buffer.byteLength(projectKernel, "utf8"), policy.projectKernelBytes);
assert.ok(policy.projectKernelBytes <= policy.projectKernelMaximumBytes, "project AGENTS.md exceeded its startup byte budget");

const sessionStart = inventory.currentDesign.sessionStart;
assert.equal(SESSION_START_JSON_MAX_BYTES, sessionStart.jsonMaximumBytes);
assert.equal(sessionStart.ordinaryStartupTelemetryWrites, 0);

const exposure = inventory.currentDesign.mcpExposure;
assert.match(exposure.lastCleanCheckoutObservation.commit, /^[0-9a-f]{40}$/u);
assert.equal(exposure.lastCleanCheckoutObservation.command, "npm run benchmark:transport:exposure");
assert.equal(exposure.lastCleanCheckoutObservation.passed, true);
assert.equal(MCP_TOOL_NAMES.length, exposure.fullDirectTools);
assert.equal(CORE_PROFILE_TOOL_NAMES.length, exposure.coreDirectTools);
assert.deepEqual([...CORE_PROFILE_TOOL_NAMES].sort(), ["capabilities", "change_plan", "search"]);
assert.equal(exposure.advancedOperationsReachableThroughDispatcher, true);
assert.equal(MCP_TOOL_NAMES.filter((name) => name !== "capabilities").length, exposure.logicalOperations);
assert.equal(exposure.firstTaskResultDecodedPayloadReductionPercent, 0);
assert.equal(exposure.repeatedTaskResultDecodedPayloadReductionPercent, 0);

assert.match(packageJson.scripts["benchmark:transport:exposure"], /--baseline-tools full --candidate-tools core/);
assert.match(packageJson.scripts.check, /startup:context-check/);
assert.match(projectKernel, /README `Codex Project Worktrees And Local Setup`/);
assert.match(projectKernel, /README `Release Automation`/);
assert.match(readme, /Codex Project Worktrees And Local Setup/);
assert.match(readme, /Release Automation/);
assert.match(plan, /truthful, low-noise readiness/);

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-startup-context-gate-"));
try {
  const repo = path.join(fixtureRoot, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "codexa-startup-context-fixture", private: true, scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(repo, "src/index.ts"), "export const startupContextFixture = true;\n", "utf8");
  git(repo, ["init"]);
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"]);

  const optInMissingSummary = await sessionStartSummary(repo, true);
  const optInMissingBytes = Buffer.byteLength(optInMissingSummary, "utf8");
  assert.match(optInMissingSummary, /Session-start dynamic context/);
  assert.match(optInMissingSummary, /Index: missing/);
  assert.match(optInMissingSummary, /Config: not-configured/);
  assert.ok(
    optInMissingBytes <= sessionStart.optInMissingFixtureMaximumBytes,
    `missing-index SessionStart fixture used ${optInMissingBytes}/${sessionStart.optInMissingFixtureMaximumBytes} bytes`
  );

  await initializeProject(repo, { cliPath: path.join(repoRoot, "dist/cli.js") });
  const defaultReadyBytes = Buffer.byteLength(await sessionStartSummary(repo, false), "utf8");
  assert.ok(
    defaultReadyBytes <= sessionStart.defaultReadyFixtureMaximumBytes,
    `default SessionStart fixture used ${defaultReadyBytes}/${sessionStart.defaultReadyFixtureMaximumBytes} bytes`
  );

  await mkdir(path.join(fixtureRoot, ".codex"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, ".codex", "WORKING.md"),
    [
      "## Active Sessions",
      "",
      "| session | agent | repo | task | status | claims | last_seen | next |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      `| session-a | codex | ${repo} | inspect startup context | active | claim:src/index.ts | now | run the bounded gate |`,
      `| session-blocked | codex | ${repo} | private blocked prose | blocked | claim:src/blocked.ts | now | inspect private notes |`,
      `| session-parked | codex | ${repo} | private parked prose | parked | claim:src/parked.ts | yesterday | wait |`
    ].join("\n"),
    "utf8"
  );
  const recoverySummary = await sessionStartSummary(
    fixtureRoot,
    true,
    { workspaceSessionId: "session-a" }
  );
  const workspaceRecoveryBytes = Buffer.byteLength(recoverySummary, "utf8");
  assert.match(recoverySummary, /task="inspect startup context"/);
  assert.match(recoverySummary, /next="run the bounded gate"/);
  assert.doesNotMatch(recoverySummary, /private blocked prose|private parked prose|inspect private notes/);
  assert.ok(
    workspaceRecoveryBytes <= sessionStart.optInWorkspaceRecoveryMaximumBytes,
    `workspace recovery fixture used ${workspaceRecoveryBytes}/${sessionStart.optInWorkspaceRecoveryMaximumBytes} bytes`
  );

  const transport = JSON.parse(execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts/benchmark-mcp-transport.mjs"),
      "--repo",
      repo,
      "--baseline-cli",
      path.join(repoRoot, "dist/cli.js"),
      "--candidate-cli",
      path.join(repoRoot, "dist/cli.js"),
      "--baseline-tools",
      "full",
      "--candidate-tools",
      "core",
      "--calls",
      "2"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        CODEXA_HOME: path.join(fixtureRoot, "codexa-home")
      }
    }
  ));
  assert.equal(transport.passed, true);
  assert.equal(transport.baseline.directToolCount, exposure.fullDirectTools);
  assert.equal(transport.candidate.directToolCount, exposure.coreDirectTools);
  assert.equal(transport.candidate.advertisedLogicalOperationCount, exposure.logicalOperations);
  assertWithin(
    transport.comparison.toolsListDecodedPayloadReductionPercent,
    exposure.toolListDecodedPayloadReductionPercent,
    exposure.fixtureTolerancePercentagePoints,
    "decoded tool-list reduction"
  );
  assertWithin(
    transport.comparison.startupAdvertisementAndDiscoveryDecodedPayloadReductionPercent,
    exposure.startupAdvertisementAndDiscoveryDecodedPayloadReductionPercent,
    exposure.fixtureTolerancePercentagePoints,
    "startup advertisement/discovery reduction"
  );
  assert.equal(
    transport.comparison.firstTaskResultDecodedPayloadReductionPercent,
    exposure.firstTaskResultDecodedPayloadReductionPercent
  );
  assert.equal(
    transport.comparison.repeatedTaskResultDecodedPayloadReductionPercent,
    exposure.repeatedTaskResultDecodedPayloadReductionPercent
  );

  process.stdout.write(
    `startup context gate: ok (project kernel ${policy.projectKernelBytes}/${policy.projectKernelMaximumBytes} bytes; `
    + `SessionStart fixtures ${defaultReadyBytes}/${optInMissingBytes}/${workspaceRecoveryBytes} bytes; `
    + `${exposure.coreDirectTools}/${exposure.fullDirectTools} direct tools; `
    + `tool-list/startup payload reductions `
    + `${transport.comparison.toolsListDecodedPayloadReductionPercent}%/`
    + `${transport.comparison.startupAdvertisementAndDiscoveryDecodedPayloadReductionPercent}%)\n`
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

function roundedReduction(baseline, candidate) {
  return Number((((baseline - candidate) / baseline) * 100).toFixed(1));
}

function assertWithin(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} drifted: measured ${actual}%, recorded ${expected}% ± ${tolerance} percentage points`
  );
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
