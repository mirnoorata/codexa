#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { SESSION_START_JSON_MAX_BYTES } = await import("../dist/session-start.js");

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
assert.ok(sessionStart.defaultReadyFixtureMaximumBytes <= 800);
assert.ok(sessionStart.optInMissingFixtureMaximumBytes <= 2048);
assert.ok(sessionStart.optInWorkspaceRecoveryMaximumBytes <= 4096);

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

process.stdout.write(
  `startup context gate: ok (project kernel ${policy.projectKernelBytes}/${policy.projectKernelMaximumBytes} bytes; `
  + `${exposure.coreDirectTools}/${exposure.fullDirectTools} direct tools; SessionStart JSON <= ${sessionStart.jsonMaximumBytes} bytes)\n`
);

function roundedReduction(baseline, candidate) {
  return Number((((baseline - candidate) / baseline) * 100).toFixed(1));
}
