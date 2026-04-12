import path from "node:path";
import { isTestPath } from "../language.js";
import type { CodexaIndex, Confidence, EvidenceTier, TestRecommendation } from "../types.js";
import { uniqueSorted } from "../util.js";
import { candidateTestCommand } from "./test-commands.js";

export function recommendTests(index: CodexaIndex, paths: string[], repoRoot = index.snapshot.repoRoot): TestRecommendation[] {
  const changedSet = new Set(paths);
  const candidates = new Map<string, { path: string; reasons: Set<string>; rank: number; evidenceTier: EvidenceTier }>();
  const changedKinds = new Set(paths.map(sourceKindForPath));
  const add = (pathValue: string, reason: string, rank = 1, sourcePath?: string, evidenceTier: EvidenceTier = "derived") => {
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
    } else {
      candidates.set(pathValue, { path: pathValue, reasons: new Set([reason]), rank, evidenceTier });
    }
  };

  for (const edge of index.testEdges) {
    if (edge.targetPath && changedSet.has(edge.targetPath)) {
      add(edge.path, `covers ${edge.targetPath}`, 5, edge.targetPath, confidenceTier(edge.confidence));
    }
    if (changedSet.has(edge.path)) {
      add(edge.path, "changed test file", 4, undefined, "authoritative");
    }
  }

  const related = transitiveImporters(index, paths, 2);
  for (const [relatedPath, source] of related) {
    const relatedFile = index.files.find((file) => file.path === relatedPath);
    if (relatedFile?.test) {
      add(relatedFile.path, `imports ${source} through affected path`, 4, source, "authoritative");
    }
  }
  for (const edge of index.testEdges) {
    if (edge.targetPath && related.has(edge.targetPath)) {
      const source = related.get(edge.targetPath) ?? edge.targetPath;
      add(edge.path, `covers ${edge.targetPath} via ${source}`, 4, source, confidenceTier(edge.confidence));
    }
  }

  for (const file of paths) {
    const basename = path.posix.basename(file).replace(/\.[^.]+$/, "");
    if (basename.length < 3) {
      continue;
    }
    for (const testFile of index.files.filter((candidate) => candidate.test)) {
      if (testFile.path.includes(basename)) {
        add(testFile.path, `near ${file}`, 2, file, "heuristic");
      }
    }
  }

  const broadPackageRoots = new Set(["atlas_api", "src", "web", "tests", "scripts"]);
  for (const file of paths.filter((candidate) => sourceKindForPath(candidate) === "python")) {
    const packageRoot = file.split("/")[0];
    if (!packageRoot || broadPackageRoots.has(packageRoot)) {
      continue;
    }
    const packageImportTests = new Set(index.imports.filter((edge) => isTestPath(edge.path) && edge.specifier.replace(/^\.+/, "").startsWith(packageRoot)).map((edge) => edge.path));
    for (const testPath of packageImportTests) {
      add(testPath, `imports ${packageRoot} package near ${file}`, 3, file, "derived");
    }
  }

  return [...candidates.values()]
    .map((candidate) => {
      const command = candidateTestCommand(repoRoot, candidate.path);
      return {
        path: candidate.path,
        reason: [...candidate.reasons].sort().join("; "),
        rank: candidate.rank,
        evidenceTier: candidate.evidenceTier,
        command: command?.command,
        commandSource: command?.source,
        commandConfidence: command?.confidence
      };
    })
    .sort((a, b) => tierScore(a.evidenceTier ?? "fallback") - tierScore(b.evidenceTier ?? "fallback") || b.rank - a.rank || a.path.localeCompare(b.path));
}

export function formatTestRecommendations(tests: TestRecommendation[]): string[] {
  if (tests.length === 0) {
    return ["- No targeted test file found."];
  }
  const lines = tests.map((test) => `- ${test.path}: ${test.evidenceTier ?? "derived"}; ${test.reason}`);
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
  const seen = new Set<string>();
  const result: TestRecommendation[] = [];
  for (const test of tests) {
    if (!seen.has(test.path)) {
      seen.add(test.path);
      result.push(test);
    }
  }
  return result.sort((a, b) => tierScore(a.evidenceTier ?? "fallback") - tierScore(b.evidenceTier ?? "fallback") || b.rank - a.rank || a.path.localeCompare(b.path));
}

export function wasTestRun(test: TestRecommendation, ranTests: string[]): boolean {
  if (ranTests.length === 0) {
    return false;
  }
  return ranTests.some((entry) => {
    const normalized = normalizeSearchText(entry);
    return normalized === normalizeSearchText(test.path) || normalized.includes(normalizeSearchText(test.path)) || (test.command ? normalized.includes(normalizeSearchText(test.command)) : false);
  });
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
  if (/\.json$/.test(filePath) || filePath.startsWith("atlas_api/packages/")) {
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

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
