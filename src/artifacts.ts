import { promises as fs } from "node:fs";
import path from "node:path";
import { renderCodexUseContract } from "./codex-contract.js";
import { ADVANCED_MCP_TOOL_NAMES, NO_SOURCE_MUTATION_CONTRACT, PRIMARY_MCP_TOOL_NAMES } from "./mcp-tool-catalog.js";
import { isPlaceholderRisk, placeholderCategory } from "./placeholder-signals.js";
import type { CodexaIndex, FileFact, ModuleClusterFact, SymbolFact } from "./types.js";
import { escapeMarkdown, formatPathLine, topBy } from "./util.js";

export async function writeArtifacts(index: CodexaIndex, outputDir: string): Promise<void> {
  await fs.mkdir(path.join(outputDir, "modules"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "playbooks"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outputDir, "README.md"), renderReadme(index), "utf8"),
    fs.writeFile(path.join(outputDir, "codex-contract.md"), renderCodexUseContract(index.freshness), "utf8"),
    fs.writeFile(path.join(outputDir, "repo-map.md"), renderRepoMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "risk-map.md"), renderRiskMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "placeholder-map.md"), renderPlaceholderMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "test-map.md"), renderTestMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "conventions.md"), renderConventions(index), "utf8"),
    fs.writeFile(path.join(outputDir, "workflows.md"), renderWorkflows(index), "utf8"),
    fs.writeFile(path.join(outputDir, "playbooks", "README.md"), renderPlaybookIndex(index), "utf8"),
    ...index.modules.slice(0, 40).map((module) =>
      fs.writeFile(path.join(outputDir, "modules", `${safeModuleName(module.name)}.md`), renderModule(index, module), "utf8")
    ),
    ...index.modules.slice(0, 20).map((module) =>
      fs.writeFile(path.join(outputDir, "playbooks", `${safeModuleName(module.name)}.md`), renderModulePlaybook(index, module), "utf8")
    )
  ]);
}

function renderReadme(index: CodexaIndex): string {
  const dirty = index.freshness.dirtyFiles.length;
  const staleLine = index.freshness.stale ? `WARNING: index stale (${index.freshness.reason}).` : `Index fresh (${index.freshness.reason}).`;
  return `# Codexa Codebase Context

${staleLine}

- Repo: \`<repo>\`
- Commit: \`${index.snapshot.headCommit ?? "none"}\`
- Indexed: \`${index.snapshot.indexedAt}\`
- Dirty files at index time: ${dirty}
- Parser errors: ${index.parserErrors.length}

## Read First

${index.files.slice(0, 12).map((file, idx) => `${idx + 1}. \`${file.path}\` - rank ${file.rank.toFixed(2)} (${rankReasonText(file)})`).join("\n")}

## Dynamic Queries

Use the primary Codexa MCP tools for the normal edit loop:

${PRIMARY_MCP_TOOL_NAMES.map((tool) => `- \`${tool}\``).join("\n")}

Advanced MCP tools remain available for deeper inspection:

${ADVANCED_MCP_TOOL_NAMES.map((tool) => `- \`${tool}\``).join("\n")}

MCP resources expose this generated artifact set under \`codexa://repo/codebase/...\`.
MCP prompts provide small workflows for snapshot-backed editing, impact-before-edit,
dirty-diff review, and targeted test planning.
Use \`search\` as the first-class target-discovery surface when a task is
ambiguous; it combines raw hits, semantic retrieval when configured, Codexa
ranking, likely tests, and gaps before \`task_brief\`.
Read \`codex-contract.md\` first when a new Codex session needs the automatic-use
rules without loading broader maps.

Facts carry \`source\` and \`confidence\`. Treat Python dynamic/framework edges marked \`heuristic\` as leads, not proof.
${NO_SOURCE_MUTATION_CONTRACT}
`;
}

function renderRepoMap(index: CodexaIndex): string {
  const modules = index.modules.slice(0, 20);
  return `# Repo Map

## Top Modules

${modules.map((mod) => `- \`${mod.name}\` - ${mod.files.length} files, rank ${mod.rank.toFixed(2)}`).join("\n")}

## Top Files

${table(
  ["Rank", "File", "Lang", "Symbols", "Usage", "Risk"],
  index.files.slice(0, 40).map((file) => [
    file.rank.toFixed(2),
    `\`${file.path}\``,
    file.language,
    String(file.symbolCount),
    String(file.usageCount),
    file.riskScore.toFixed(1)
  ])
)}

## Notable Symbols

${rankSymbols(index)
  .slice(0, 80)
  .map((symbol) => `- \`${symbol.qualifiedName}\` (${symbol.kind}, ${symbol.language}) at \`${formatPathLine(symbol.path, symbol.range?.startLine)}\``)
  .join("\n")}
`;
}

function renderRiskMap(index: CodexaIndex): string {
  const riskyFiles = topBy(index.files, (file) => file.riskScore + file.rankReasons.dirtyRisk + file.rankReasons.publicSurface, 40);
  return `# Risk Map

Freshness: ${index.freshness.stale ? `STALE (${index.freshness.reason})` : index.freshness.reason}

## Highest-Risk Files

${table(
  ["File", "Risk", "Dirty", "Reasons"],
  riskyFiles.map((file) => [
    `\`${file.path}\``,
    file.riskScore.toFixed(1),
    file.dirty ? "yes" : "no",
    rankReasonText(file)
  ])
)}

## Risk Signals

${index.risks
  .slice(0, 120)
  .map((risk) => `- \`${formatPathLine(risk.path, risk.range?.startLine)}\` - ${risk.signal}: ${risk.reason} (${risk.confidence})`)
  .join("\n")}
`;
}

function renderPlaceholderMap(index: CodexaIndex): string {
  const placeholderRisks = index.risks.filter(isPlaceholderRisk);
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));
  const fileScores = new Map<string, { count: number; score: number }>();
  for (const risk of placeholderRisks) {
    const current = fileScores.get(risk.path) ?? { count: 0, score: 0 };
    current.count += 1;
    current.score += risk.score;
    fileScores.set(risk.path, current);
  }
  const categoryCounts = [...placeholderRisks.reduce((map, risk) => {
    const category = placeholderCategory(risk.signal);
    map.set(category, (map.get(category) ?? 0) + 1);
    return map;
  }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b));
  const contextCounts = [...placeholderRisks.reduce((map, risk) => {
    const file = fileByPath.get(risk.path);
    const context = file?.generated
      ? "generated"
      : file?.test
        ? "test"
        : file?.language === "markdown" || /(^|\/)docs?\//u.test(risk.path)
          ? "docs"
          : "production";
    map.set(context, (map.get(context) ?? 0) + 1);
    return map;
  }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b));
  const topFiles = [...fileScores.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 40);
  const shownSignals = [...placeholderRisks]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0) || a.signal.localeCompare(b.signal))
    .slice(0, 160);
  return `# Placeholder Map

Freshness: ${index.freshness.stale ? `STALE (${index.freshness.reason})` : index.freshness.reason}

Placeholder findings are indexed as normal risk signals. \`change_plan\` stores
their baseline, and \`post_edit_review\` reports newly introduced placeholder
signals and removed signals within the saved baseline scope as risk deltas.

## Summary

- Total placeholder signals: ${placeholderRisks.length}
- Files with placeholder signals: ${fileScores.size}

## Categories

${categoryCounts.length > 0 ? categoryCounts.map(([category, count]) => `- ${category}: ${count}`).join("\n") : "- none"}

## Contexts

${contextCounts.length > 0 ? contextCounts.map(([context, count]) => `- ${context}: ${count}`).join("\n") : "- none"}

## Highest Placeholder Files

${table(
  ["File", "Findings", "Score"],
  topFiles.map(([filePath, summary]) => [`\`${filePath}\``, String(summary.count), summary.score.toFixed(2)])
)}

## Placeholder Signals

Showing ${shownSignals.length} of ${placeholderRisks.length}.

${shownSignals.length > 0
  ? shownSignals
      .map((risk) => `- \`${formatPathLine(risk.path, risk.range?.startLine)}\` - ${risk.signal}: ${risk.reason} (${risk.confidence}, score ${risk.score.toFixed(2)})`)
      .join("\n")
  : "- none detected"}
`;
}

function renderTestMap(index: CodexaIndex): string {
  const testFiles = index.files.filter((file) => file.test);
  return `# Test Map

## Likely Test Files

${testFiles.slice(0, 80).map((file) => `- \`${file.path}\` - rank ${file.rank.toFixed(2)}`).join("\n")}

## Test Edges

${index.testEdges
  .slice(0, 120)
  .map((edge) => `- \`${edge.path}\`${edge.targetPath ? ` -> \`${edge.targetPath}\`` : ""}: ${edge.reason} (${edge.confidence})`)
  .join("\n")}
`;
}

function renderConventions(index: CodexaIndex): string {
  const languages = [...new Set(index.files.map((file) => file.language))].sort();
  const tests = index.files.filter((file) => file.test).length;
  return `# Conventions

- Languages indexed: ${languages.join(", ")}
- Test files detected: ${tests}
- Source facts come from Tree-sitter, git, manifests, or explicit heuristics.
- Python definitions/imports are authoritative syntax facts.
- Python call/reference links are derived unless dynamic/framework behavior makes them heuristic.
- Generated Codexa artifacts are additive. Do not overwrite human-maintained \`AGENTS.md\`.
- Use freshness status before trusting impact or test-plan output.
- Candidate test commands require package/Python metadata provenance; missing
  provenance means Codexa should omit the command instead of inventing one.
- Context packs include known gaps such as parser errors, stale state,
  heuristic-only links, and changed files without symbol ranges.
- For code edits, use \`change_plan\` with \`saveSnapshot: true\` before editing
  and \`post_edit_review\` after editing.
- Use \`session_memory\` to recall or explicitly save session-local working
  memory. Auto-recorded \`viewed\` entries are Codexa-derived; agent claims stay
  agent-asserted and must not be promoted into codebase facts.
- Use \`focus_brief\` for broad natural-language tasks, then narrow with
  \`search\`, \`repo_map\`, or explicit files before verification planning. Use
  \`workflow_path\` for route/job/process changes and \`dependency_path\` for
  explicit source-to-target relationship questions.
- Rule signals cover queue/run lifecycle, generator-node invariants,
  manifest/adapter contracts, managed output, frontend polling, and
  release/service-control boundaries when those facts are present.
`;
}

function renderWorkflows(index: CodexaIndex): string {
  return `# Workflow Map

Workflow traces are heuristic process maps built from route/job decorators,
manifest node facts, typed endpoint/store/adapter/UI/test edges, call/reference
links, imports, risks, and test edges.
Treat them as read-first guidance, then verify with source.

${index.workflows
  .slice(0, 80)
  .map(
    (workflow) => `## ${workflow.title}

- Kind: ${workflow.workflowKind}
- Confidence: ${workflow.confidence}
- Rank: ${workflow.rank.toFixed(2)}
- Entry: \`${formatPathLine(workflow.entryPath, workflow.range?.startLine)}\`
- Related files: ${workflow.relatedFiles.slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}
- Tests: ${workflow.tests.slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}

${workflow.summary}

${workflow.steps
  .slice(0, 12)
  .map((step, index) => `${index + 1}. ${step.kind}: \`${formatPathLine(step.path, step.line)}\` - ${step.label} (${step.confidence})`)
  .join("\n")}
`
  )
  .join("\n")}
`;
}

function renderPlaybookIndex(index: CodexaIndex): string {
  return `# Codexa Change Playbooks

These playbooks are generated from indexed facts. They are meant to tell Codex
how to approach changes safely without loading the whole graph.

## General Protocol

1. Run \`focus_brief\` for broad or ambiguous tasks.
2. Run \`change_plan\` with \`saveSnapshot: true\` before editing concrete files.
3. Run \`workflow_path\` for route, job, queue, adapter, or manifest changes.
4. Run \`callers\`, \`callees\`, or \`dependency_path\` for API and rename work.
5. Run \`post_edit_review\` after edits, then \`test_plan\` before final verification.

## Module Playbooks

${index.modules.slice(0, 20).map((module) => `- \`playbooks/${safeModuleName(module.name)}.md\` - ${module.files.length} files, rank ${module.rank.toFixed(2)}`).join("\n")}
`;
}

function renderModulePlaybook(index: CodexaIndex, module: ModuleClusterFact): string {
  const moduleFiles = module.files
    .map((filePath) => index.files.find((file) => file.path === filePath))
    .filter((file): file is FileFact => Boolean(file))
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
  const risks = index.risks.filter((risk) => module.files.includes(risk.path)).slice(0, 20);
  const workflows = index.workflows.filter((workflow) => workflow.relatedFiles.some((file) => module.files.includes(file))).slice(0, 10);
  const tests = index.testEdges.filter((edge) => module.files.includes(edge.targetPath ?? "") || module.files.includes(edge.path)).slice(0, 20);
  const languages = [...new Set(moduleFiles.map((file) => file.language))].sort();
  return `# Playbook: ${module.name}

${module.summary}

## When Editing This Module

- Languages: ${languages.join(", ") || "unknown"}
- Read first: ${moduleFiles.slice(0, 8).map((file) => `\`${file.path}\``).join(", ") || "none"}
- Use \`task_brief\` with the concrete file/symbol once the target is known.
- Use \`workflow_path\` if any workflow below is related to the change.
- Treat heuristic risks as prompts to verify source, not as proof.

## Invariants And Risks

${risks.length > 0 ? risks.map((risk) => `- \`${formatPathLine(risk.path, risk.range?.startLine)}\`: ${risk.signal} - ${risk.reason} (${risk.confidence})`).join("\n") : "- none detected"}

## Workflows

${workflows.length > 0 ? workflows.map((workflow) => `- ${workflow.title}: ${workflow.summary}`).join("\n") : "- none detected"}

## Tests

${tests.length > 0 ? tests.map((edge) => `- \`${edge.path}\`${edge.targetPath ? ` covers \`${edge.targetPath}\`` : ""}: ${edge.reason} (${edge.confidence})`).join("\n") : "- no direct test edges detected"}

## Safe Change Recipe

1. Read the target and the top importer/caller from Codexa output.
2. Check risk signals before changing public surface, adapters, config, routes, or generated manifests.
3. Prefer tests listed above; if none are listed, inspect repo test metadata before inventing commands.
4. Run \`post_edit_review\` after edits if a snapshot exists; otherwise re-run
   \`task_brief\` if freshness reports \`dirty-files-changed\`.
`;
}

function renderModule(index: CodexaIndex, module: ModuleClusterFact): string {
  const files = module.files
    .map((filePath) => index.files.find((file) => file.path === filePath))
    .filter((file): file is FileFact => Boolean(file))
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
  const symbols = index.symbols.filter((symbol) => module.files.includes(symbol.path)).slice(0, 60);
  return `# Module: ${module.name}

${module.summary}

## Read First

${files.slice(0, 12).map((file) => `- \`${file.path}\` - rank ${file.rank.toFixed(2)} (${rankReasonText(file)})`).join("\n")}

## Symbols

${symbols.map((symbol) => `- \`${symbol.qualifiedName}\` (${symbol.kind}) at \`${formatPathLine(symbol.path, symbol.range?.startLine)}\``).join("\n")}
`;
}

function rankReasonText(file: FileFact): string {
  const entries = Object.entries(file.rankReasons)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, value]) => `${key} ${value.toFixed(1)}`);
  return entries.join(", ") || "baseline";
}

function rankSymbols(index: CodexaIndex): SymbolFact[] {
  const fileRanks = new Map(index.files.map((file) => [file.path, file.rank]));
  const usageCounts = new Map<string, number>();
  for (const usage of index.usageSites) {
    if (usage.targetSymbolId) {
      usageCounts.set(usage.targetSymbolId, (usageCounts.get(usage.targetSymbolId) ?? 0) + 1);
    }
  }
  return [...index.symbols].sort((a, b) => {
    const scoreA = symbolScore(a, fileRanks, usageCounts);
    const scoreB = symbolScore(b, fileRanks, usageCounts);
    return scoreB - scoreA || a.path.localeCompare(b.path) || (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0);
  });
}

function symbolScore(symbol: SymbolFact, fileRanks: Map<string, number>, usageCounts: Map<string, number>): number {
  const kindBoost = ["route", "class", "function", "method"].includes(symbol.kind) ? 1 : 0;
  return (fileRanks.get(symbol.path) ?? 0) + Math.log2((usageCounts.get(symbol.id) ?? 0) + 1) + (symbol.exported ? 2 : 0) + kindBoost;
}

function table(headers: string[], rows: string[][]): string {
  const escapedHeaders = headers.map(escapeMarkdown);
  const escapedRows = rows.map((row) => row.map(escapeMarkdown));
  return [
    `| ${escapedHeaders.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...escapedRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function safeModuleName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}
