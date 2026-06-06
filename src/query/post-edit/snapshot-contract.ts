import type { CodexaIndex, TaskSnapshotRiskFile, TaskSnapshotSymbol, TestRecommendation, TestRecommendationProvenance } from "../../types.js";
import { findFile } from "../targets.js";

export function snapshotSymbolBaseline(index: CodexaIndex, paths: string[]): Record<string, TaskSnapshotSymbol[]> {
  const pathSet = new Set(paths);
  const result: Record<string, TaskSnapshotSymbol[]> = {};
  for (const filePath of pathSet) {
    result[filePath] = index.symbols
      .filter((symbol) => symbol.path === filePath)
      .map((symbol) => ({
        id: symbol.id,
        path: symbol.path,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        kind: symbol.kind,
        range: symbol.range
      }))
      .sort((a, b) => (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName));
  }
  return result;
}

export function snapshotRiskBaseline(index: CodexaIndex, paths: string[]): Record<string, TaskSnapshotRiskFile> {
  const pathSet = new Set(paths);
  const result: Record<string, TaskSnapshotRiskFile> = {};
  for (const filePath of pathSet) {
    const file = findFile(index, filePath);
    const signals = index.risks
      .filter((risk) => risk.path === filePath)
      .map((risk) => `${risk.signal}: ${risk.reason}`)
      .sort();
    result[filePath] = {
      riskScore: file?.riskScore ?? signals.length,
      signals
    };
  }
  return result;
}

export function compactSnapshotTests(tests: TestRecommendation[], repoRoot: string): TestRecommendation[] {
  return tests.map((test) => ({
    ...test,
    command: test.command?.replaceAll(repoRoot, "<repo>"),
    provenance: {
      ...(test.provenance ?? legacyTestProvenance(test, [])),
      origin: "snapshot"
    }
  }));
}

export function reconcileSnapshotTests(
  tests: TestRecommendation[],
  reviewScope: string[],
  snapshotScope: string[]
): { trusted: TestRecommendation[]; degraded: TestRecommendation[] } {
  const scope = new Set(reviewScope.length > 0 ? reviewScope : snapshotScope);
  const trusted: TestRecommendation[] = [];
  const degraded: TestRecommendation[] = [];
  for (const test of tests) {
    const provenance = normalizeTestProvenance(test.provenance) ?? legacyTestProvenance(test, snapshotScope);
    const targetPaths = provenance.targetPaths.length > 0 ? provenance.targetPaths : snapshotScope;
    const directTestTarget = scope.has(test.path) && provenance.sources.includes("explicit_target") && targetPaths.includes(test.path);
    const matchesScope = targetPaths.some((targetPath) => scope.has(targetPath)) || directTestTarget;
    if (!provenance.degraded && matchesScope) {
      trusted.push({
        ...test,
        provenance: {
          ...provenance,
          origin: "snapshot",
          targetPaths
        }
      });
      continue;
    }
    degraded.push(
      degradeSnapshotTest(
        test,
        {
          ...provenance,
          origin: "snapshot",
          targetPaths
        },
        matchesScope
          ? provenance.degradedReason ?? "snapshot planned-test evidence was already degraded"
          : `snapshot test targets ${targetPaths.slice(0, 5).join(", ") || "unknown"} do not match review scope ${[...scope].slice(0, 5).join(", ") || "unknown"}`
      )
    );
  }
  return { trusted, degraded };
}

function legacyTestProvenance(test: TestRecommendation, snapshotScope: string[]): TestRecommendationProvenance {
  return {
    schemaVersion: 1,
    origin: "snapshot",
    sources: ["snapshot_legacy"],
    targetPaths: snapshotScope,
    evidence: [test.reason].filter(Boolean).slice(0, 4),
    degraded: true,
    degradedReason: "legacy snapshot test lacks planned-test provenance"
  };
}

function normalizeTestProvenance(value: TestRecommendationProvenance | undefined): TestRecommendationProvenance | undefined {
  if (!value || value.schemaVersion !== 1) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    origin: value.origin ?? "snapshot",
    sources: Array.isArray(value.sources) ? value.sources : ["snapshot_legacy"],
    targetPaths: Array.isArray(value.targetPaths) ? value.targetPaths : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    degraded: value.degraded,
    degradedReason: value.degradedReason
  };
}

function degradeSnapshotTest(test: TestRecommendation, provenance: TestRecommendationProvenance, reason: string): TestRecommendation {
  return {
    ...test,
    provenance: {
      ...provenance,
      degraded: true,
      degradedReason: reason
    }
  };
}
