import path from "node:path";
import { isTestPath } from "../language.js";
import type { ChangeType, CodexaIndex, Confidence, EvidenceTier, TestRecommendation, TestRecommendationProvenance, TestRecommendationProvenanceSource } from "../types.js";
import { uniqueSorted } from "../util.js";
import { candidateTestCommand } from "./test-commands.js";

/**
 * Recommend tests to run for a set of changed paths.
 *
 * `changeType` narrows cross-language recommendations so editorial noise
 * stays low:
 *
 *   - "style"  — the edit is a cosmetic/presentation change (CSS,
 *     Tailwind-class swap, template-only markup). Python pytest files are
 *     dropped from the recommendation list when no Python source was
 *     actually edited, because a style diff cannot break Python behavior.
 *     Likewise, TypeScript test files are dropped when no TS/JS source
 *     was edited.
 *   - "rename" / "delete" / "api" / "behavior" / "unknown" — today's
 *     behavior: surface everything the graph indicates.
 *
 * The filter only prunes authoritative/derived entries whose language
 * demonstrably cannot be affected by the edited files. Heuristic/fallback
 * entries already go through `compatibleKindWithTest()` for the same
 * reason.
 */
export function recommendTests(
  index: CodexaIndex,
  paths: string[],
  repoRoot = index.snapshot.repoRoot,
  changeType: ChangeType = "unknown"
): TestRecommendation[] {
  const changedSet = new Set(paths);
  interface Candidate {
    path: string;
    reasons: Set<string>;
    rank: number;
    evidenceTier: EvidenceTier;
    provenanceSources: Set<TestRecommendationProvenanceSource>;
    provenanceTargets: Set<string>;
    // True when any edge that contributed to this candidate directly
    // covers a file in the changed set (as opposed to reaching it via
    // transitive importers or package-wide heuristics). Such candidates
    // must survive change-type narrowing — dropping them would hide the
    // exact test the edit is supposed to be verified against.
    directlyCoversChanged: boolean;
  }
  const candidates = new Map<string, Candidate>();
  const changedKinds = new Set(paths.map(sourceKindForPath));
  const add = (
    pathValue: string,
    reason: string,
    rank = 1,
    sourcePath?: string,
    evidenceTier: EvidenceTier = "derived",
    directlyCoversChanged = false,
    provenanceSource: TestRecommendationProvenanceSource = evidenceTier === "heuristic" || evidenceTier === "fallback" ? "heuristic_match" : "derived_impact_expansion",
    provenanceTargets: string[] = sourcePath ? [sourcePath] : paths
  ) => {
    const compatibilityGate = evidenceTier === "heuristic" || evidenceTier === "fallback";
    if (sourcePath && compatibilityGate && !compatibleTestPath(sourcePath, pathValue)) {
      return;
    }
    if (!sourcePath && compatibilityGate && !compatibleWithAnyChanged(changedKinds, pathValue)) {
      return;
    }
    const existing = candidates.get(pathValue);
    if (existing) {
      existing.reasons.add(reason);
      existing.rank += rank;
      existing.evidenceTier = betterTier(existing.evidenceTier, evidenceTier);
      existing.provenanceSources.add(provenanceSource);
      for (const target of provenanceTargets) {
        existing.provenanceTargets.add(target);
      }
      if (directlyCoversChanged) {
        existing.directlyCoversChanged = true;
      }
    } else {
      candidates.set(pathValue, {
        path: pathValue,
        reasons: new Set([reason]),
        rank,
        evidenceTier,
        provenanceSources: new Set([provenanceSource]),
        provenanceTargets: new Set(provenanceTargets),
        directlyCoversChanged
      });
    }
  };

  for (const edge of index.testEdges) {
    if (edge.targetPath && changedSet.has(edge.targetPath)) {
      // Direct coverage of an edited file. NEVER filter this out on
      // change-type narrowing — even if the test is a different language
      // than the edit, this edge is the whole point.
      add(edge.path, `${edge.reason}; covers ${edge.targetPath}`, 5, edge.targetPath, confidenceTier(edge.confidence), true, "authoritative_test_edge", [edge.targetPath]);
    }
    if (changedSet.has(edge.path)) {
      add(edge.path, "changed test file", 4, edge.path, "authoritative", true, "explicit_target", [edge.path]);
    }
  }

  const related = transitiveImporters(index, paths, 2);
  for (const [relatedPath, source] of related) {
    const relatedFile = index.files.find((file) => file.path === relatedPath);
    if (relatedFile?.test) {
      // Reached via transitive importers — NOT direct coverage. Subject
      // to change-type narrowing.
      add(relatedFile.path, `imports ${source} through affected path`, 4, source, "authoritative", false, "derived_impact_expansion", [source]);
    }
  }
  for (const edge of index.testEdges) {
    if (edge.targetPath && related.has(edge.targetPath)) {
      const source = related.get(edge.targetPath) ?? edge.targetPath;
      add(edge.path, `${edge.reason}; covers ${edge.targetPath} via ${source}`, 4, source, confidenceTier(edge.confidence), false, "derived_impact_expansion", [source, edge.targetPath]);
    }
  }

  for (const file of paths) {
    const basename = path.posix.basename(file).replace(/\.[^.]+$/, "");
    if (basename.length < 3) {
      continue;
    }
    for (const testFile of index.files.filter((candidate) => candidate.test)) {
      if (testFile.path.includes(basename)) {
        add(testFile.path, `near ${file}`, 2, file, "heuristic", false, "heuristic_match", [file]);
      }
    }
  }

  const broadPackageRoots = new Set(["api", "backend", "server", "service", "src", "web", "tests", "scripts"]);
  for (const file of paths.filter((candidate) => sourceKindForPath(candidate) === "python")) {
    const packageRoot = file.split("/")[0];
    if (!packageRoot || broadPackageRoots.has(packageRoot)) {
      continue;
    }
    const packageImportTests = new Set(index.imports.filter((edge) => isTestPath(edge.path) && edge.specifier.replace(/^\.+/, "").startsWith(packageRoot)).map((edge) => edge.path));
    for (const testPath of packageImportTests) {
      add(testPath, `imports ${packageRoot} package near ${file}`, 3, file, "derived", false, "package_import", [file]);
    }
  }

  for (const candidate of candidates.values()) {
    const testFile = index.files.find((file) => file.path === candidate.path);
    const outcomeBoost = Math.min(3, testFile?.rankReasons?.outcomeHistory ?? 0);
    if (outcomeBoost > 0) {
      candidate.rank += outcomeBoost;
      candidate.reasons.add("outcome history: this test was recently missed, unaccounted for, or repeatedly needed");
      candidate.provenanceSources.add("outcome_history");
      candidate.provenanceTargets.add(candidate.path);
    }
  }

  const withDirectCoverage = new Set<string>();
  for (const candidate of candidates.values()) {
    if (candidate.directlyCoversChanged) {
      withDirectCoverage.add(candidate.path);
    }
  }

  const results = [...candidates.values()]
    .map((candidate) => {
      const command = candidateTestCommand(repoRoot, candidate.path);
      const provenance: TestRecommendationProvenance = {
        schemaVersion: 1,
        origin: "current",
        sources: uniqueSorted(candidate.provenanceSources) as TestRecommendationProvenanceSource[],
        targetPaths: uniqueSorted(candidate.provenanceTargets),
        evidence: [...candidate.reasons].sort().slice(0, 8)
      };
      return {
        path: candidate.path,
        reason: limitReasonText([...candidate.reasons].sort().join("; ")),
        rank: candidate.rank,
        evidenceTier: candidate.evidenceTier,
        command: command?.command,
        commandCwd: command?.commandCwd,
        commandExecutable: command?.commandExecutable,
        commandArgs: command?.commandArgs,
        commandSource: command?.source,
        commandConfidence: command?.confidence,
        provenance
      };
    });

  const narrowed = narrowByChangeType(results, changedKinds, changeType, withDirectCoverage);

  return narrowed.sort(
    (a, b) =>
      tierScore(a.evidenceTier ?? "fallback") - tierScore(b.evidenceTier ?? "fallback") ||
      b.rank - a.rank ||
      a.path.localeCompare(b.path)
  );
}

/**
 * Apply change-type narrowing to an already-merged test recommendation
 * set (e.g. snapshot-planned + context-derived + freshly-recommended).
 * Safe to run on any list; it's a no-op for change types other than
 * style and it never drops authoritative/derived tier entries.
 *
 * Used by post-edit review to ensure that a snapshot saved WITHOUT a
 * change-type — the common case when `/codexa-plan` runs before the
 * user decides the edit is cosmetic — still produces a clean
 * recommendation set when the user later runs `--change-type style`.
 */
export function narrowTestRecommendationsByChangeType(
  results: TestRecommendation[],
  paths: string[],
  changeType: ChangeType
): TestRecommendation[] {
  if (changeType !== "style") {
    return results;
  }
  const changedKinds = new Set(paths.map(sourceKindForPath));
  return narrowByChangeType(results, changedKinds, changeType, new Set());
}

/**
 * Drop test entries whose language demonstrably cannot be affected by the
 * edited files for the given change type. For `style`, this means: if no
 * Python source is in the dirty set, Python pytest files that came in
 * only via a heuristic guess (package-scope, basename match, fallback)
 * disappear — they would otherwise show up as low-signal noise in a
 * pure CSS diff.
 *
 * What the filter deliberately does NOT touch:
 *   - authoritative / derived entries — the index proved coverage
 *     through explicit testEdges or transitive import chains. A TS
 *     snapshot test that covers a CSS file through App.tsx, or a
 *     server-rendering pytest that covers a template through a route,
 *     is exactly the test a style edit should run.
 *   - entries whose path directly covers an edited file (even at
 *     heuristic tier) — a deliberate match on the exact asset stays.
 *
 * So the effective scope of narrowing is: heuristic/fallback tier
 * candidates whose language doesn't match any edited file's language.
 */
function narrowByChangeType(
  results: TestRecommendation[],
  changedKinds: Set<string>,
  changeType: ChangeType,
  withDirectCoverage: Set<string>
): TestRecommendation[] {
  if (changeType !== "style") {
    return results;
  }
  const hasPythonChanges = changedKinds.has("python");
  const hasTypescriptChanges = changedKinds.has("typescript");
  return results.filter((entry) => {
    if (withDirectCoverage.has(entry.path)) {
      return true;
    }
    // Authoritative / derived entries come from the explicit test-edge
    // graph and from transitive importers — both are proof of coverage
    // through the dependency graph, not a guess. Never drop those on
    // change-type narrowing; at worst the graph is wrong about a
    // cross-language edge, which is a separate class of bug.
    if (entry.evidenceTier === "authoritative" || entry.evidenceTier === "derived") {
      return true;
    }
    const testKind = testFileKind(entry.path);
    if (testKind === "python" && !hasPythonChanges) {
      return false;
    }
    if (testKind === "typescript" && !hasTypescriptChanges) {
      return false;
    }
    return true;
  });
}

function testFileKind(testPath: string): "python" | "typescript" | "other" {
  if (/\.py$/.test(testPath)) {
    return "python";
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath)) {
    return "typescript";
  }
  return "other";
}

export function formatTestRecommendations(tests: TestRecommendation[]): string[] {
  if (tests.length === 0) {
    return ["- No targeted test file found."];
  }
  const lines = tests.map((test) => {
    const degraded = test.provenance?.degraded ? `; degraded: ${test.provenance.degradedReason ?? "provenance degraded"}` : "";
    return `- ${test.path}: ${test.evidenceTier ?? "derived"}; ${test.reason}${degraded}`;
  });
  const commands = uniqueSorted(tests.flatMap((test) => (test.command ? [test.command] : [])));
  if (commands.length === 0) {
    return lines;
  }
  return [
    ...lines,
    "",
    "Candidate test commands:",
    ...commands.slice(0, 8).map((command) => {
      const matching = tests.find((test) => test.command === command);
      const source = matching?.commandSource ?? "unknown";
      const confidence = matching?.commandConfidence ?? "heuristic";
      return `- ${command} (${confidence}; source: ${source})`;
    })
  ];
}

export function uniqueTests(tests: TestRecommendation[]): TestRecommendation[] {
  const byPath = new Map<string, TestRecommendation>();
  for (const test of tests) {
    const existing = byPath.get(test.path);
    if (!existing) {
      byPath.set(test.path, test);
      continue;
    }
    byPath.set(test.path, mergeTestRecommendations(existing, test));
  }
  return [...byPath.values()].sort((a, b) => tierScore(a.evidenceTier ?? "fallback") - tierScore(b.evidenceTier ?? "fallback") || b.rank - a.rank || a.path.localeCompare(b.path));
}

export function wasTestRun(test: TestRecommendation, ranTests: string[]): boolean {
  if (ranTests.length === 0) {
    return false;
  }
  const expected = normalizeDirectTestIdentity(test.path);
  return ranTests.some((entry) => normalizeDirectTestIdentity(entry) === expected);
}

function mergeTestRecommendations(existing: TestRecommendation, candidate: TestRecommendation): TestRecommendation {
  const existingDegraded = existing.provenance?.degraded === true;
  const candidateDegraded = candidate.provenance?.degraded === true;
  const preferred =
    existingDegraded !== candidateDegraded
      ? candidateDegraded
        ? existing
        : candidate
      : tierScore(candidate.evidenceTier ?? "fallback") < tierScore(existing.evidenceTier ?? "fallback") || candidate.rank > existing.rank
        ? candidate
        : existing;
  const other = preferred === existing ? candidate : existing;
  return {
    ...preferred,
    reason: limitReasonText(uniqueSorted([preferred.reason, other.reason].filter(Boolean)).join("; ")),
    rank: Math.max(preferred.rank, other.rank),
    evidenceTier: betterTier(preferred.evidenceTier ?? "fallback", other.evidenceTier ?? "fallback"),
    provenance: mergeTestProvenance(preferred.provenance, other.provenance)
  };
}

function mergeTestProvenance(a?: TestRecommendationProvenance, b?: TestRecommendationProvenance): TestRecommendationProvenance | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (a?.degraded === true && b && b.degraded !== true) {
    return b;
  }
  if (b?.degraded === true && a && a.degraded !== true) {
    return a;
  }
  const base = a && !a.degraded ? a : b && !b.degraded ? b : a ?? b!;
  return {
    schemaVersion: 1,
    origin: base.origin,
    sources: uniqueSorted([...(a?.sources ?? []), ...(b?.sources ?? [])]) as TestRecommendationProvenanceSource[],
    targetPaths: uniqueSorted([...(a?.targetPaths ?? []), ...(b?.targetPaths ?? [])]),
    evidence: uniqueSorted([...(a?.evidence ?? []), ...(b?.evidence ?? [])]).slice(0, 10),
    degraded: a?.degraded === true && b?.degraded === true ? true : undefined,
    degradedReason: a?.degraded === true && b?.degraded === true ? a.degradedReason ?? b.degradedReason : undefined
  };
}

function transitiveImporters(index: CodexaIndex, sourcePaths: string[], maxDepth: number): Map<string, string> {
  const result = new Map<string, string>();
  const queue = sourcePaths.map((sourcePath) => ({ path: sourcePath, origin: sourcePath, depth: 0 }));
  const seen = new Set(queue.map((entry) => entry.path));
  for (const entry of queue) {
    result.set(entry.path, entry.origin);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const edge of index.imports.filter((candidate) => candidate.resolvedPath === current.path)) {
      if (seen.has(edge.path)) {
        continue;
      }
      seen.add(edge.path);
      result.set(edge.path, current.origin);
      queue.push({ path: edge.path, origin: current.origin, depth: current.depth + 1 });
    }
  }
  return result;
}

function compatibleWithAnyChanged(changedKinds: Set<string>, testPath: string): boolean {
  if (changedKinds.size === 0) {
    return true;
  }
  return [...changedKinds].some((kind) => kind === "unknown" || compatibleKindWithTest(kind, testPath));
}

function compatibleTestPath(sourcePath: string, testPath: string): boolean {
  return compatibleKindWithTest(sourceKindForPath(sourcePath), testPath);
}

function compatibleKindWithTest(kind: string, testPath: string): boolean {
  if (kind === "python") {
    return /\.py$/.test(testPath);
  }
  if (kind === "typescript") {
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath);
  }
  if (kind === "manifest") {
    return /\.py$/.test(testPath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath);
  }
  if (kind === "operator" || kind === "unknown") {
    return true;
  }
  return true;
}

function sourceKindForPath(filePath: string): "python" | "typescript" | "manifest" | "operator" | "unknown" {
  if (/\.py$/.test(filePath)) {
    return "python";
  }
  if (/\.[cm]?[jt]sx?$/.test(filePath)) {
    return "typescript";
  }
  if (/\.json$/.test(filePath)) {
    return "manifest";
  }
  if (/\.(sh|service)$/.test(filePath) || filePath.startsWith("scripts/")) {
    return "operator";
  }
  return "unknown";
}

function confidenceTier(confidence: Confidence): EvidenceTier {
  if (confidence === "authoritative") return "authoritative";
  if (confidence === "derived") return "derived";
  return "heuristic";
}

function betterTier(a: EvidenceTier, b: EvidenceTier): EvidenceTier {
  return tierScore(a) <= tierScore(b) ? a : b;
}

function tierScore(tier: EvidenceTier): number {
  return tier === "authoritative" ? 0 : tier === "derived" ? 1 : tier === "heuristic" ? 2 : 3;
}

function normalizeDirectTestIdentity(value: string): string {
  const trimmed = value.trim();
  if (/\s/u.test(trimmed)) {
    return "";
  }
  return trimmed
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/+/gu, "/")
    .replace(/(\.py)::.*$/u, "$1")
    .toLowerCase();
}

function limitReasonText(value: string, maxLength = 360): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 14).trimEnd()} ... truncated`;
}
