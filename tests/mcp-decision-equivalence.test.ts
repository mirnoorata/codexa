import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalMcpDetailedProjection, compactMcpResult, MCP_DETAILED_PROJECTION_TARGET_BYTES } from "../src/mcp/compaction.js";
import { mcpDecisionKernel, withMcpDelivery } from "../src/mcp/decision-kernel.js";
import { createMcpResultArtifactRouter, persistMcpResultArtifact, readMcpResultArtifact } from "../src/mcp/result-artifacts.js";
import type { FreshnessInfo, QueryResult } from "../src/types.js";

const primaryModes = ["session_context", "search", "task_brief", "change_plan", "post_edit_review", "test_plan", "proof_card", "capabilities"] as const;

describe("MCP decision equivalence across delivery paths", () => {
  it("uses one >96 KiB detailed projection for resource and inline delivery, including explicit budget overrides", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-detailed-projection-parity-"));
    const router = createMcpResultArtifactRouter();
    const packet = primaryPacket("capabilities", repo);
    (packet.data as Record<string, unknown>).largeEvidence = Array.from({ length: 40 }, (_, index) => ({
      id: `evidence-${index}`,
      first: `first-${index}-${"a".repeat(1_200)}`,
      second: `second-${index}-${"b".repeat(1_200)}`,
      third: `third-${index}-${"c".repeat(1_200)}`,
      fourth: `fourth-${index}-${"d".repeat(1_200)}`
    }));
    const previousBudget = process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
    try {
      const resourceProjection = canonicalMcpDetailedProjection(packet);
      const reference = await persistMcpResultArtifact(repo, resourceProjection, binding("capabilities", repo, packet.freshness!), router);
      const resourceRoundTrip = JSON.parse(await readMcpResultArtifact(repo, reference.id)) as QueryResult;
      const explicitDetailed = withMcpDelivery(canonicalMcpDetailedProjection(packet), {
        schemaVersion: 1,
        requestedFormat: "detailed",
        effectiveFormat: "detailed"
      });

      expect(bytes(resourceRoundTrip.data)).toBeGreaterThan(96_000);
      expect((resourceRoundTrip.data as { mcp: { targetBytes: number } }).mcp.targetBytes).toBe(MCP_DETAILED_PROJECTION_TARGET_BYTES);
      expect((resourceRoundTrip.data as { mcp: { returnedBytes: number } }).mcp.returnedBytes).toBe(bytes(resourceRoundTrip.data));
      expect(withoutDeliveryMetadata(explicitDetailed.data)).toEqual(withoutDeliveryMetadata(resourceRoundTrip.data));

      process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = "110000";
      const overriddenResource = canonicalMcpDetailedProjection(packet);
      const overriddenDetailed = withMcpDelivery(canonicalMcpDetailedProjection(packet), {
        schemaVersion: 1,
        requestedFormat: "detailed",
        effectiveFormat: "detailed"
      });
      expect((overriddenResource.data as { mcp: { targetBytes: number; returnedBytes: number } }).mcp).toMatchObject({ targetBytes: 110_000 });
      expect(bytes(overriddenResource.data)).toBeLessThanOrEqual(110_000);
      expect(withoutDeliveryMetadata(overriddenDetailed.data)).toEqual(withoutDeliveryMetadata(overriddenResource.data));
    } finally {
      await router.close();
      if (previousBudget === undefined) delete process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES;
      else process.env.CODEXA_MCP_STRUCTURED_BUDGET_BYTES = previousBudget;
    }
  });

  it.each([4_000, 12_000])("preserves every primary decision through auto, resource, and detailed delivery at %i bytes", async (targetBytes) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), `codexa-decision-${targetBytes}-`));
    const router = createMcpResultArtifactRouter();
    for (const mode of primaryModes) {
      const packet = primaryPacket(mode, repo);
      const sourceKernel = mcpDecisionKernel(packet.data as Record<string, unknown>, mode, packet.freshness);
      const resourcePacket = compactMcpResult(packet, { format: "detailed", targetBytes: MCP_DETAILED_PROJECTION_TARGET_BYTES });
      const reference = await persistMcpResultArtifact(repo, resourcePacket, binding(mode, repo, packet.freshness!), router);
      const resourceRoundTrip = JSON.parse(await readMcpResultArtifact(repo, reference.id)) as QueryResult;
      const detailed = withMcpDelivery(compactMcpResult(packet, { format: "detailed", targetBytes }), {
        schemaVersion: 1,
        requestedFormat: "detailed",
        effectiveFormat: "detailed"
      });
      const auto = withMcpDelivery(compactMcpResult(packet, { format: "concise", targetBytes }), {
        schemaVersion: 1,
        requestedFormat: "auto",
        effectiveFormat: "concise",
        resultId: reference.id,
        resultUri: reference.uri
      });

      expect(bytes(detailed.data), `${mode} detailed budget`).toBeLessThanOrEqual(targetBytes);
      expect(bytes(auto.data), `${mode} auto budget`).toBeLessThanOrEqual(targetBytes);
      const expected = decisionSignature(sourceKernel);
      expect(decisionSignature(kernelOf(resourceRoundTrip)), `${mode} resource decision`).toEqual(expected);
      expect(decisionSignature(kernelOf(detailed)), `${mode} detailed decision`).toEqual(expected);
      expect(decisionSignature(kernelOf(auto)), `${mode} auto decision`).toEqual(expected);
      expectEffectiveActionability(sourceKernel, resourceRoundTrip, `${mode} resource actionability`);
      expectEffectiveActionability(sourceKernel, detailed, `${mode} detailed actionability`);
      expectEffectiveActionability(sourceKernel, auto, `${mode} auto actionability`);
      expectGapAccounting(kernelOf(detailed));
      expectGapAccounting(kernelOf(auto));
    }
  }, 120_000);

  it("computes exact omitted-gap counts at ordinary, narrowed, terminal, and delivery-terminal tiers", () => {
    const gaps = Array.from({ length: 40 }, (_, index) => `gap-${index}-${"x".repeat(180)}`);
    const packet = primaryPacket("post_edit_review", "/repo");
    (packet.data as Record<string, unknown>).gaps = gaps;
    (packet.data as Record<string, unknown>).invariants = Array.from({ length: 16 }, (_, index) => ({ id: `invariant-${index}-${"i".repeat(120)}`, status: "satisfied", statement: "s".repeat(220) }));
    (packet.data as Record<string, unknown>).invariantReviews = Array.from({ length: 16 }, (_, index) => ({ invariantId: `invariant-${index}-${"i".repeat(120)}`, status: "satisfied" }));
    const kernel = mcpDecisionKernel(packet.data as Record<string, unknown>, "post_edit_review", packet.freshness);
    expectGapAccounting(kernel);
    expect((kernel.gapCount as number)).toBe(40);

    for (const targetBytes of [4_000, 12_000]) {
      const delivered = withMcpDelivery(compactMcpResult(packet, { format: "concise", targetBytes }), {
        schemaVersion: 1,
        requestedFormat: "concise",
        effectiveFormat: "concise",
        resultId: `mr_${"a".repeat(64)}`,
        resultUri: `codexa://repo/mcp-results/rr_${"b".repeat(32)}/mr_${"a".repeat(64)}`
      });
      expectGapAccounting(kernelOf(delivered));
      expect((kernelOf(delivered).gapCount as number)).toBe(40);
    }
  });
});

function primaryPacket(mode: (typeof primaryModes)[number], repoRoot: string): QueryResult {
  const common = {
    mode,
    runtime: { repoRoot, gitHead: "head-active", routingSource: "explicit-repo", workspaceSessionId: "decision-session" },
    gaps: [],
    huge: Array.from({ length: 120 }, (_, index) => ({ index, text: "z".repeat(280) }))
  };
  const files = Array.from({ length: 18 }, (_, index) => `src/file-${index}.ts`);
  const tests = Array.from({ length: 16 }, (_, index) => ({ path: `tests/file-${index}.test.ts`, status: "recommended" }));
  const dataByMode: Record<(typeof primaryModes)[number], Record<string, unknown>> = {
    session_context: {
      ...common,
      task: "resume bounded work",
      focusFiles: files.map((file, index) => ({ path: file, rank: 100 - index })),
      nextReads: files.slice(2),
      workflows: [{ id: "workflow-main", title: "main workflow", entryPath: "src/file-0.ts" }],
      tests,
      verificationCommands: ["npm test", "npm run build"],
      nextCall: { tool: "change_plan", reason: "target is bounded" }
    },
    search: {
      ...common,
      query: "primary decision target",
      actionability: "orientation",
      rawExactHitCount: 2,
      rawExactFileCount: 2,
      patterns: ["primary", "decision"],
      raw: { sufficient: false, files: files.slice(0, 4), hits: files.slice(0, 4).map((file, line) => ({ path: file, line, reason: "exact" })) },
      files: files.map((file, index) => ({ path: file, rank: 100 - index })),
      symbols: files.map((file, index) => ({ id: `symbol-${index}`, qualifiedName: `symbol${index}`, path: file, kind: "function" })),
      usageSites: files.slice(0, 5).map((file, index) => ({ name: `use${index}`, path: file, kind: "call" })),
      diagnostics: ["one diagnostic"],
      tests
    },
    task_brief: {
      ...common,
      task: "change primary target",
      focusFiles: files.map((file, index) => ({ path: file, rank: 100 - index })),
      nextReads: files.slice(1),
      changedFiles: files.slice(2),
      workflows: [{ id: "workflow-main", title: "main workflow", entryPath: "src/file-0.ts" }],
      tests,
      verificationCommands: ["npm test"],
      nextCall: { tool: "change_plan", reason: "save the bounded plan" }
    },
    change_plan: {
      ...common,
      task: "change primary target",
      taskId: "task-primary",
      actionability: "edit_ready",
      editReadiness: { editable: true, status: "edit-ready", reason: "explicit files" },
      snapshot: { taskId: "task-primary", path: ".codex/cache/task.json", planRevision: 3, invariants: [{ id: "no-domain-hardcodes", statement: "no domain-specific hardcodes" }] },
      files,
      plannedEditTargets: files.slice(0, 12),
      targetCandidates: files.slice(0, 4).map((file, index) => ({ candidateId: `candidate-${index}`, path: file, status: "selected" })),
      tests,
      requiredWorkflowChecks: [{ kind: "workflow", target: "direct-dispatch", status: "required" }],
      requiredDependencyChecks: [{ kind: "dependency", target: "decision-kernel", status: "required" }]
    },
    post_edit_review: {
      ...common,
      task: "review primary target",
      taskId: "task-primary",
      verdict: "aligned",
      completionAuthority: "complete",
      inspectMode: "none",
      files,
      reviewTargets: files.slice(0, 12),
      unplannedEditedFiles: [],
      changedSinceSnapshot: files.slice(0, 5).map((file) => ({ path: file, status: "modified" })),
      invariants: [{ id: "no-domain-hardcodes", statement: "no domain-specific hardcodes" }],
      invariantReviews: [{ invariantId: "no-domain-hardcodes", status: "satisfied" }],
      loopReview: { status: "resolved", totalDistinctAttempts: 2, attemptsSincePlan: 1, unresolvedAttemptsSincePlan: 0, reasons: [] },
      testsNotRun: [],
      missedLikelyTests: [],
      verificationLedger: [{ kind: "test", target: "npm test", status: "pass" }],
      outcome: { outcomeId: "outcome-primary", persisted: true },
      planRevision: 3
    },
    test_plan: {
      ...common,
      actionability: "verify",
      targetFiles: files,
      unindexedTargetFiles: [],
      rejectedTargetFiles: [],
      changedFiles: files.slice(0, 5),
      tests,
      verificationCommands: ["npm test", "npm run build"],
      testsNotRun: [],
      verificationLedgerPreview: [{ kind: "test", target: "npm test", status: "planned" }]
    },
    proof_card: {
      ...common,
      actionability: "verify",
      lifecycle: {
        status: "loaded",
        planRevision: 3,
        invariants: [{ id: "no-domain-hardcodes", statement: "no domain-specific hardcodes" }],
        invariantReviews: [{ invariantId: "no-domain-hardcodes", status: "satisfied" }],
        attempts: [{ attemptId: "attempt-1", attemptStatus: "resolved", changedFiles: files.slice(0, 2), failureSignals: [] }]
      },
      decisionLog: { status: "loaded", sessionId: "decision-session", baselineRevision: 2, currentRevision: 3, baselineIntact: true, summaryHashValid: true },
      verification: { recommendedCommands: ["npm test", "npm run build"], tests, reported: { hasEvidence: true }, artifacts: { selected: [{ artifactId: "artifact-1" }], accepted: [{ artifactId: "artifact-1", status: "accepted" }], rejected: [] } },
      nextCommands: ["npm test"]
    },
    capabilities: {
      ...common,
      actionability: "orientation",
      capabilityHash: "c".repeat(64),
      operationCount: 3,
      operations: [
        { name: "repo_map", requiredInputs: [] },
        { name: "impact", requiredInputs: ["file|symbol"] },
        { name: "session_memory", requiredInputs: [] }
      ]
    }
  };
  return { freshness: freshness(repoRoot), text: `${mode} detailed packet`, data: dataByMode[mode] };
}

function freshness(repoRoot: string): FreshnessInfo {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-primary",
    repoRoot,
    gitRoot: repoRoot,
    headCommit: "head-active",
    indexedAt: "2026-07-13T00:00:00.000Z",
    dirtyFiles: [],
    dirtyFileHashes: {},
    indexedDirtyFileHashes: {},
    indexedDirtyFiles: [],
    missing: false,
    stale: false,
    reason: "fresh",
    parserErrorCount: 0
  };
}

function binding(tool: string, repoRoot: string, currentFreshness: FreshnessInfo) {
  return {
    tool,
    checkout: { repoRoot, gitHead: "head-active", routingSource: "explicit-repo", workspaceSessionId: "decision-session" },
    freshness: {
      snapshotId: currentFreshness.snapshotId,
      headCommit: currentFreshness.headCommit,
      indexedAt: currentFreshness.indexedAt,
      missing: currentFreshness.missing,
      stale: currentFreshness.stale,
      reason: currentFreshness.reason
    }
  };
}

function kernelOf(result: QueryResult): Record<string, unknown> {
  const data = record(result.data);
  const kernel = record(data?.decisionKernel);
  if (!kernel) throw new Error("missing decision kernel");
  return kernel;
}

function decisionSignature(kernel: Record<string, unknown>): Record<string, unknown> {
  const authority = record(kernel.authority) ?? {};
  const identity = record(kernel.identity) ?? {};
  return compact({
    mode: kernel.mode,
    authority: {
      actionability: authority.originalActionability ?? authority.actionability,
      verdict: authority.verdict,
      packetVerdict: authority.packetVerdict,
      completionAuthority: authority.completionAuthority,
      inspectMode: authority.inspectMode,
      editReadiness: scalarDecision(record(authority.editReadiness))
    },
    identity: {
      taskId: identity.taskId,
      snapshot: identityValue(identity.snapshot),
      snapshotBlock: identityValue(identity.snapshotBlock),
      snapshotLoad: identityValue(identity.snapshotLoad),
      checkout: identityValue(identity.checkout),
      freshness: identityValue(identity.freshness)
    },
    invariants: invariantStates(kernel.invariants),
    loop: scalarDecision(record(kernel.loop)),
    lifecycle: scalarDecision(record(kernel.lifecycle)),
    decisionLog: scalarDecision(record(kernel.decisionLog)),
    search: modeSectionSignature(record(kernel.search)),
    scope: modeSectionSignature(record(kernel.scope)),
    capabilities: capabilitySignature(record(kernel.capabilities)),
    advanced: modeSectionSignature(record(kernel.advanced)),
    verification: verificationSignature(record(kernel.verification)),
    failureSignalCount: kernel.failureSignalCount,
    gapCount: kernel.gapCount,
    planRevision: kernel.planRevision
  });
}

function expectEffectiveActionability(sourceKernel: Record<string, unknown>, result: QueryResult, label: string): void {
  const sourceAuthority = record(sourceKernel.authority) ?? {};
  const actualKernel = kernelOf(result);
  const actualAuthority = record(actualKernel.authority) ?? {};
  const expected = sourceAuthority.actionability;
  const actual = actualAuthority.actionability;
  if (sourceKernel.detailsRequired === true) {
    expect([expected, "blocked"], label).toContain(actual);
    if (actual === "blocked" && expected !== "blocked") {
      expect(actualAuthority.originalActionability, `${label} original`).toBe(expected);
    }
  } else {
    expect(actual, label).toBe(expected);
  }
  expect(record(result.data)?.actionability, `${label} top-level`).toBe(actual);
}

function modeSectionSignature(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  const counts = Object.fromEntries(Object.entries(value).filter(([key, entry]) => (key.endsWith("Count") || key.endsWith("Omitted") || key === "status" || key === "rawSufficient") && ["string", "number", "boolean"].includes(typeof entry)));
  const keys = ["plannedEditTargets", "reviewTargets", "targetFiles", "focusFiles", "files", "symbols", "targetCandidates", "nextReads", "changedSinceSnapshot", "workflows", "rawHits"];
  const top = Object.fromEntries(keys.map((key) => [key, firstIdentity(value[key])]).filter(([, entry]) => entry !== undefined));
  return compact({ ...counts, top, target: identityValue(value.target), detail: scalarDecision(record(value.detail)), counts: scalarDecision(record(value.counts)) });
}

function verificationSignature(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  const counts = Object.fromEntries(Object.entries(value).filter(([key, entry]) => (key.endsWith("Count") || key.endsWith("Omitted") || typeof entry === "boolean") && ["number", "boolean"].includes(typeof entry)));
  const first = Object.fromEntries(Object.entries(value).filter(([, entry]) => Array.isArray(entry)).map(([key, entry]) => [key, firstIdentity(entry)]).filter(([, entry]) => entry !== undefined));
  return compact({ ...counts, first, reported: scalarDecision(record(value.reported)), artifacts: scalarDecision(record(value.artifacts)) });
}

function capabilitySignature(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  return compact({
    action: value.action,
    capabilityHash: value.capabilityHash,
    operationCount: value.operationCount,
    operation: value.operation,
    schemaHash: value.schemaHash,
    requiredInputs: value.requiredInputs,
    inputNames: value.inputNames,
    operations: Array.isArray(value.operations) ? value.operations.map((entry) => firstIdentity([entry])) : undefined
  });
}

function identityValue(value: unknown): unknown {
  if (!record(value)) return value;
  const source = record(value)!;
  return compact(Object.fromEntries(Object.entries(source).filter(([key, entry]) => ["taskId", "id", "path", "status", "reason", "missingReason", "repoRoot", "gitHead", "headCommit", "routingSource", "missing", "stale", "planRevision"].includes(key) && entry !== undefined)));
}

function scalarDecision(value: Record<string, unknown> | undefined): unknown {
  if (!value) return undefined;
  return compact(Object.fromEntries(Object.entries(value).filter(([key, entry]) => typeof entry === "number" || typeof entry === "boolean" || ["status", "attemptStatus", "baselineIntact", "summaryHashValid", "planRevision"].includes(key))));
}

function invariantStates(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry): [string, string] => {
    if (Array.isArray(entry)) return [String(entry[0]), String(entry[1] ?? "unreviewed")];
    const object = record(entry) ?? {};
    return [String(object.id ?? "unknown"), String(object.status ?? "unreviewed")];
  });
}

function firstIdentity(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entry = value[0];
  if (typeof entry === "string") return entry;
  const object = record(entry);
  if (!object) return String(entry);
  return compact({ id: object.id ?? object.candidateId, path: object.path ?? object.file, name: object.name ?? object.label, symbol: object.symbol, tool: object.tool, command: object.command, target: object.target, status: object.status });
}

function expectGapAccounting(kernel: Record<string, unknown>): void {
  const gaps = Array.isArray(kernel.gaps) ? kernel.gaps : [];
  const count = typeof kernel.gapCount === "number" ? kernel.gapCount : gaps.length;
  const omitted = typeof kernel.gapsOmitted === "number" ? kernel.gapsOmitted : 0;
  expect(omitted).toBe(count - gaps.length);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function withoutDeliveryMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete copy.delivery;
  if (copy.mcp && typeof copy.mcp === "object" && !Array.isArray(copy.mcp)) {
    delete (copy.mcp as Record<string, unknown>).returnedBytes;
  }
  return copy;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0) && (!record(entry) || Object.keys(record(entry)!).length > 0)));
}
