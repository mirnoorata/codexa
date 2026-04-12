import { isGeneratedPath, isTestPath, languageForPath, moduleNameForPath } from "../language.js";
import type { ChangedFileEntry, ChangedSymbol, CodexaIndex, DiffImpactGroup, FileFact, FreshnessInfo } from "../types.js";
import { uniqueSorted } from "../util.js";

export function groupDiffImpact(
  index: CodexaIndex,
  changedEntries: ChangedFileEntry[],
  changedSymbols: ChangedSymbol[],
  unindexedChanged: string[]
): DiffImpactGroup[] {
  const symbolsByPath = new Map<string, ChangedSymbol[]>();
  for (const entry of changedSymbols) {
    const list = symbolsByPath.get(entry.symbol.path) ?? [];
    list.push(entry);
    symbolsByPath.set(entry.symbol.path, list);
  }

  const groups = new Map<string, DiffImpactGroup>();
  for (const entry of changedEntries) {
    const filePath = entry.path;
    const file = index.files.find((candidate) => candidate.path === filePath);
    const kind = classifyImpactPath(filePath, file);
    const language = file?.language ?? languageForPath(filePath);
    const module = file ? moduleNameForPath(file.path) : moduleNameForPath(filePath);
    const key = `${kind}:${language}:${module}`;
    const existing =
      groups.get(key) ??
      ({
        key,
        module,
        kind,
        language,
        files: [],
        diffKinds: [],
        changedSymbols: [],
        unindexedFiles: [],
        rank: 0,
        risk: 0
      } satisfies DiffImpactGroup);
    existing.files.push(filePath);
    existing.diffKinds.push(entry.kind);
    existing.changedSymbols.push(...(symbolsByPath.get(filePath) ?? []));
    if (!file || unindexedChanged.includes(filePath)) {
      existing.unindexedFiles.push(filePath);
    }
    existing.rank += file?.rank ?? 0;
    existing.risk += file?.riskScore ?? (kind === "config" ? 2 : 0);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: uniqueSorted(group.files),
      diffKinds: uniqueSorted(group.diffKinds) as DiffImpactGroup["diffKinds"],
      unindexedFiles: uniqueSorted(group.unindexedFiles),
      changedSymbols: group.changedSymbols.sort(
        (a, b) =>
          a.symbol.path.localeCompare(b.symbol.path) ||
          (a.symbol.range?.startLine ?? 0) - (b.symbol.range?.startLine ?? 0) ||
          a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName)
      )
    }))
    .sort((a, b) => b.risk - a.risk || b.rank - a.rank || a.key.localeCompare(b.key));
}

export function formatDiffGroups(groups: DiffImpactGroup[]): string[] {
  if (groups.length === 0) {
    return ["- none"];
  }
  return groups.map((group) => {
    const symbols = group.changedSymbols
      .slice(0, 4)
      .map((entry) => entry.symbol.qualifiedName)
      .join(", ");
    const symbolSuffix = symbols ? `; symbols ${symbols}${group.changedSymbols.length > 4 ? ", ..." : ""}` : "";
    const unindexedSuffix = group.unindexedFiles.length > 0 ? `; unindexed ${group.unindexedFiles.length}` : "";
    const kindSuffix = group.diffKinds.length > 0 ? `; changes ${group.diffKinds.join(",")}` : "";
    return `- ${group.module} [${group.kind}/${group.language}]: ${group.files.length} files, risk ${group.risk.toFixed(1)}${kindSuffix}${symbolSuffix}${unindexedSuffix}`;
  });
}

export function indexGaps(index: CodexaIndex, freshness: FreshnessInfo, unindexedChanged: string[] = []): string[] {
  const gaps: string[] = [];
  if (freshness.stale) {
    gaps.push(`index stale: ${freshness.reason}`);
  }
  if (index.parserErrors.length > 0) {
    gaps.push(`parser errors: ${index.parserErrors.length} file(s), first ${index.parserErrors[0].path}`);
  }
  const heuristicUsages = index.usageSites.filter((usage) => usage.confidence === "heuristic").length;
  if (heuristicUsages > 0) {
    gaps.push(`heuristic usage links present: ${heuristicUsages}`);
  }
  if (unindexedChanged.length > 0) {
    gaps.push(`changed files without symbol ranges: ${unindexedChanged.slice(0, 5).join(", ")}${unindexedChanged.length > 5 ? ", ..." : ""}`);
  }
  return uniqueSorted(gaps);
}

export function formatGaps(gaps: string[]): string[] {
  if (gaps.length === 0) {
    return ["- none"];
  }
  return gaps.slice(0, 10).map((gap) => `- ${gap}`);
}

function classifyImpactPath(filePath: string, file?: FileFact): DiffImpactGroup["kind"] {
  if (filePath.startsWith(".codex/") || file?.generated || isGeneratedPath(filePath)) {
    return "generated";
  }
  if (file?.test || isTestPath(filePath)) {
    return "test";
  }
  if (/\.(md|mdx|rst|txt)$/.test(filePath) || filePath.startsWith("docs/")) {
    return "docs";
  }
  if (
    /\.(json|toml|ya?ml|ini|service|env|cfg)$/.test(filePath) ||
    /(^|\/)(Dockerfile|docker-compose|package|tsconfig|vite\.config|vitest\.config|pyproject|requirements)/.test(filePath) ||
    /^scripts\/[^/]+\.sh$/.test(filePath)
  ) {
    return "config";
  }
  if (file) {
    return "source";
  }
  return "unknown";
}
