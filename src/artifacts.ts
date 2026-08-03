import { promises as fs } from "node:fs";
import path from "node:path";
import { renderCodexUseContract } from "./codex-contract.js";
import { CORE_PROFILE_TOOL_NAMES, DISPATCHABLE_MCP_TOOL_NAMES, NO_SOURCE_MUTATION_CONTRACT } from "./mcp-tool-catalog.js";
import { moduleArtifactFileName } from "./module-artifact-name.js";
import { isPlaceholderRisk, placeholderCategory } from "./placeholder-signals.js";
import type { CodexaIndex, FileFact, ModuleClusterFact, WorkflowTraceFact, SymbolFact } from "./types.js";
import { escapeMarkdown, formatPathLine, topBy } from "./util.js";

export async function writeArtifacts(index: CodexaIndex, outputDir: string): Promise<void> {
  const modulesDir = path.join(outputDir, "modules");
  const playbooksDir = path.join(outputDir, "playbooks");
  await fs.mkdir(modulesDir, { recursive: true });
  await fs.mkdir(playbooksDir, { recursive: true });
  const moduleFileNames = index.modules.slice(0, 40).map(moduleArtifactFileName);
  const playbookFileNames = index.modules.slice(0, 20).map(moduleArtifactFileName);
  // A filename scheme change or a removed module must not leave stale
  // generated resources discoverable through MCP after the next index build.
  await Promise.all([
    pruneGeneratedMarkdown(modulesDir, new Set(moduleFileNames)),
    pruneGeneratedMarkdown(playbooksDir, new Set(["README.md", ...playbookFileNames]))
  ]);
  await Promise.all([
    fs.writeFile(path.join(outputDir, "README.md"), renderReadme(index), "utf8"),
    fs.writeFile(path.join(outputDir, "codex-contract.md"), renderCodexUseContract(index.freshness), "utf8"),
    fs.writeFile(path.join(outputDir, "repo-map.md"), renderRepoMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "relational-packets.md"), renderRelationalPackets(index), "utf8"),
    fs.writeFile(path.join(outputDir, "relational-packets.json"), renderRelationalPacketsJson(index), "utf8"),
    fs.writeFile(path.join(outputDir, "relational-graph.json"), renderRelationalGraphJson(index), "utf8"),
    fs.writeFile(path.join(outputDir, "packet-summary-prompts.ndjson"), renderPacketSummaryPrompts(index), "utf8"),
    fs.writeFile(path.join(outputDir, "risk-map.md"), renderRiskMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "placeholder-map.md"), renderPlaceholderMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "test-map.md"), renderTestMap(index), "utf8"),
    fs.writeFile(path.join(outputDir, "conventions.md"), renderConventions(index), "utf8"),
    fs.writeFile(path.join(outputDir, "workflows.md"), renderWorkflows(index), "utf8"),
    fs.writeFile(path.join(outputDir, "playbooks", "README.md"), renderPlaybookIndex(index), "utf8"),
    ...index.modules.slice(0, 40).map((module) =>
      fs.writeFile(path.join(outputDir, "modules", moduleArtifactFileName(module)), renderModule(index, module), "utf8")
    ),
    ...index.modules.slice(0, 20).map((module) =>
      fs.writeFile(path.join(outputDir, "playbooks", moduleArtifactFileName(module)), renderModulePlaybook(index, module), "utf8")
    )
  ]);
}

async function pruneGeneratedMarkdown(directory: string, retainedNames: Set<string>): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name.endsWith(".md") && !retainedNames.has(entry.name))
      .map((entry) => fs.rm(path.join(directory, entry.name), { force: true }))
  );
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

The optimized core exposes only the decision points that can usually repay
their schema and response cost:

${CORE_PROFILE_TOOL_NAMES.map((tool) => `- \`${tool}\``).join("\n")}

All non-core operations remain available through \`capabilities\` (or directly
in full mode):

${DISPATCHABLE_MCP_TOOL_NAMES.map((tool) => `- \`${tool}\``).join("\n")}

MCP resources expose this generated artifact set under \`codexa://repo/codebase/...\`.
MCP prompts provide small workflows for snapshot-backed editing, impact-before-edit,
dirty-diff review, and targeted test planning.
Use \`search\` as the first-class target-discovery surface when a task is
ambiguous; it combines raw hits, semantic retrieval when configured, Codexa
ranking, likely tests, and gaps. Stop Codexa when raw evidence is sufficient.
Read \`relational-packets.md\` when exact grep misses but the task likely maps
to a process, symbol neighborhood, or module cluster.
Use \`relational-packets.json\`, \`relational-graph.json\`, and
\`packet-summary-prompts.ndjson\` for tools that need bounded structured packet
data, graph visualization input, or explicit opt-in summary jobs.
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

function renderRelationalPackets(index: CodexaIndex): string {
  return `# Relational Packets

These generated packets summarize process traces and graph-aware module
clusters precomputed at index time. They are read-first guidance, not proof;
verify the cited source paths before editing.

Structured companion artifacts:

- \`relational-packets.json\` - bounded process and cluster packets.
- \`relational-graph.json\` - graph-view export for files, workflows, modules, and edges.
- \`packet-summary-prompts.ndjson\` - opt-in summary prompts; Codexa does not call a model during indexing.

## Process Packets

${index.workflows
  .slice(0, 60)
  .map(
    (workflow) => `### ${workflow.title}

- Kind: ${workflow.workflowKind}
- Process: ${workflow.processKind ?? "unknown"}
- Entry score: ${workflow.entryScore ?? 0}
- Confidence: ${workflow.confidence}
- Entry: \`${formatPathLine(workflow.entryPath, workflow.range?.startLine)}\`
- Terminals: ${(workflow.terminalFiles ?? []).slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}
- Modules: ${(workflow.relatedModules ?? []).slice(0, 8).join(", ") || "none"}
- Tests: ${workflow.tests.slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}
- Evidence: ${evidenceCountText(workflow.evidenceCounts)}

${workflow.summary}
`
  )
  .join("\n") || "- none detected"}

## Cluster Packets

${index.modules
  .slice(0, 60)
  .map(
    (module) => `### ${module.name}

- Kind: ${module.clusterKind ?? "path"}
- Rank: ${module.rank.toFixed(2)}
- Relations: ${module.relationCount ?? 0} total, ${module.crossModuleRelationCount ?? 0} cross-module
- Read first: ${(module.topFiles ?? module.files).slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}
- Symbols: ${(module.topSymbols ?? []).slice(0, 8).map((symbol) => `\`${symbol}\``).join(", ") || "none"}
- Workflows: ${(module.workflows ?? []).slice(0, 6).join(", ") || "none"}
- Tests: ${(module.tests ?? []).slice(0, 6).map((file) => `\`${file}\``).join(", ") || "none"}
- Risks: ${(module.risks ?? []).slice(0, 6).join(", ") || "none"}
- Evidence: ${evidenceCountText(module.evidenceCounts)}

${module.summary}
`
  )
  .join("\n") || "- none detected"}
`;
}

function renderRelationalPacketsJson(index: CodexaIndex): string {
  const packetStore = {
    schemaVersion: 1,
    generatedAt: index.snapshot.indexedAt,
    snapshot: {
      snapshotId: index.snapshot.snapshotId,
      headCommit: index.snapshot.headCommit,
      freshness: index.freshness.reason
    },
    artifacts: {
      markdown: "relational-packets.md",
      graph: "relational-graph.json",
      summaryPrompts: "packet-summary-prompts.ndjson"
    },
    processPackets: index.workflows.slice(0, 120).map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      workflowKind: workflow.workflowKind,
      processKind: workflow.processKind,
      entryScore: workflow.entryScore,
      confidence: workflow.confidence,
      entryPath: workflow.entryPath,
      entryLine: workflow.range?.startLine,
      relatedFiles: workflow.relatedFiles.slice(0, 40),
      terminalFiles: (workflow.terminalFiles ?? []).slice(0, 12),
      relatedModules: (workflow.relatedModules ?? []).slice(0, 12),
      tests: workflow.tests.slice(0, 20),
      stepCounts: workflow.stepCounts,
      evidenceCounts: workflow.evidenceCounts,
      summary: workflow.summary,
      truncation: workflow.truncation
    })),
    clusterPackets: index.modules.slice(0, 120).map((module) => ({
      id: module.id,
      name: module.name,
      clusterKind: module.clusterKind ?? "path",
      confidence: module.confidence,
      rank: roundNumber(module.rank),
      communityScore: module.communityScore,
      sourceModules: (module.sourceModules ?? []).slice(0, 16),
      files: module.files.slice(0, 40),
      topFiles: (module.topFiles ?? module.files).slice(0, 16),
      topSymbols: (module.topSymbols ?? []).slice(0, 24),
      workflows: (module.workflows ?? []).slice(0, 20),
      tests: (module.tests ?? []).slice(0, 20),
      risks: (module.risks ?? []).slice(0, 20),
      relationCount: module.relationCount ?? 0,
      crossModuleRelationCount: module.crossModuleRelationCount ?? 0,
      evidenceCounts: module.evidenceCounts,
      evidenceProfile: module.evidenceProfile,
      summarySource: module.summarySource ?? "deterministic",
      summaryPrompt: module.summaryPrompt,
      summary: module.summary,
      truncation: module.truncation
    }))
  };
  return `${JSON.stringify(packetStore, null, 2)}\n`;
}

function renderRelationalGraphJson(index: CodexaIndex): string {
  const nodes = new Map<string, Record<string, unknown>>();
  const edges: Array<Record<string, unknown>> = [];
  const topFiles = new Set<string>();
  for (const file of index.files.slice(0, 180)) {
    topFiles.add(file.path);
  }
  for (const workflow of index.workflows.slice(0, 80)) {
    topFiles.add(workflow.entryPath);
    for (const file of [...workflow.relatedFiles, ...(workflow.terminalFiles ?? []), ...workflow.tests].slice(0, 40)) {
      topFiles.add(file);
    }
  }
  for (const module of index.modules.slice(0, 80)) {
    for (const file of (module.topFiles ?? module.files).slice(0, 16)) {
      topFiles.add(file);
    }
  }

  for (const file of index.files.filter((file) => topFiles.has(file.path)).slice(0, 240)) {
    nodes.set(fileNodeId(file.path), {
      id: fileNodeId(file.path),
      type: "file",
      label: file.path,
      path: file.path,
      rank: roundNumber(file.rank),
      language: file.language,
      test: file.test,
      generated: file.generated
    });
  }
  for (const workflow of index.workflows.slice(0, 80)) {
    nodes.set(workflowNodeId(workflow.id), {
      id: workflowNodeId(workflow.id),
      type: "workflow",
      label: workflow.title,
      workflowKind: workflow.workflowKind,
      processKind: workflow.processKind,
      entryScore: workflow.entryScore,
      confidence: workflow.confidence
    });
    for (const file of uniqueGraphFiles([workflow.entryPath, ...workflow.relatedFiles, ...(workflow.terminalFiles ?? []), ...workflow.tests]).slice(0, 40)) {
      if (nodes.has(fileNodeId(file))) {
        edges.push({ id: `workflow:${workflow.id}:${file}`, kind: "TOUCHES", source: workflowNodeId(workflow.id), target: fileNodeId(file), confidence: workflow.confidence });
      }
    }
  }
  for (const module of index.modules.slice(0, 80)) {
    nodes.set(moduleNodeId(module.id), {
      id: moduleNodeId(module.id),
      type: "module",
      label: module.name,
      clusterKind: module.clusterKind ?? "path",
      rank: roundNumber(module.rank),
      communityScore: module.communityScore,
      sourceModules: (module.sourceModules ?? []).slice(0, 12)
    });
    for (const file of (module.topFiles ?? module.files).slice(0, 16)) {
      if (nodes.has(fileNodeId(file))) {
        edges.push({ id: `module:${module.id}:${file}`, kind: "CONTAINS", source: moduleNodeId(module.id), target: fileNodeId(file), confidence: module.confidence });
      }
    }
  }
  for (const edge of index.graphEdges
    .filter((edge) => edge.fromPath && edge.toPath && nodes.has(fileNodeId(edge.fromPath)) && nodes.has(fileNodeId(edge.toPath)))
    .sort((a, b) => b.weight - a.weight || a.edgeKind.localeCompare(b.edgeKind) || (a.fromPath ?? "").localeCompare(b.fromPath ?? "") || (a.toPath ?? "").localeCompare(b.toPath ?? ""))
    .slice(0, 600)) {
    edges.push({
      id: `graph:${edge.id}`,
      kind: edge.edgeKind,
      source: fileNodeId(edge.fromPath!),
      target: fileNodeId(edge.toPath!),
      confidence: edge.confidence,
      factSource: edge.source,
      weight: roundNumber(edge.weight),
      reason: edge.reason
    });
  }

  const graphEdgesReturned = edges.filter((edge) => typeof edge.id === "string" && String(edge.id).startsWith("graph:")).length;
  const graph = {
    schemaVersion: 1,
    generatedAt: index.snapshot.indexedAt,
    snapshotId: index.snapshot.snapshotId,
    nodes: [...nodes.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    edges: dedupeGraphExportEdges(edges).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    truncation: {
      files: { total: index.files.length, returned: [...nodes.values()].filter((node) => node.type === "file").length },
      workflows: { total: index.workflows.length, returned: Math.min(index.workflows.length, 80) },
      modules: { total: index.modules.length, returned: Math.min(index.modules.length, 80) },
      graphEdges: { total: index.graphEdges.length, returned: graphEdgesReturned }
    }
  };
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function renderPacketSummaryPrompts(index: CodexaIndex): string {
  const prompts = [
    ...index.workflows.slice(0, 80).map((workflow) => workflowSummaryPromptRecord(workflow)),
    ...index.modules.slice(0, 80).map((module) => moduleSummaryPromptRecord(module))
  ];
  return `${prompts.map((prompt) => JSON.stringify(prompt)).join("\n")}\n`;
}

function workflowSummaryPromptRecord(workflow: WorkflowTraceFact): Record<string, unknown> {
  const inputFiles = uniqueGraphFiles([workflow.entryPath, ...workflow.relatedFiles, ...(workflow.terminalFiles ?? []), ...workflow.tests]).slice(0, 40);
  return {
    schemaVersion: 1,
    kind: "workflow",
    id: workflow.id,
    title: workflow.title,
    summarySource: "llm-ready",
    inputFiles,
    prompt: [
      `Summarize workflow "${workflow.title}" for a coding agent using only cited files.`,
      `Cover process boundaries, entry path, terminal files, tests, and confidence gaps.`,
      `Entry: ${workflow.entryPath}.`,
      `Files: ${inputFiles.slice(0, 16).join(", ") || "none"}.`
    ].join(" ")
  };
}

function moduleSummaryPromptRecord(module: ModuleClusterFact): Record<string, unknown> {
  const inputFiles = (module.topFiles ?? module.files).slice(0, 40);
  return {
    schemaVersion: 1,
    kind: "module",
    id: module.id,
    name: module.name,
    clusterKind: module.clusterKind ?? "path",
    summarySource: "llm-ready",
    inputFiles,
    prompt: module.summaryPrompt ?? `Summarize module cluster "${module.name}" for a coding agent using only cited files. Files: ${inputFiles.join(", ") || "none"}.`
  };
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
- For exact local edits, use source tools and tests with zero Codexa calls.
  Use \`change_plan\` only for multi-file or materially risky changes.
- Let a true completion/Stop hook own final post-edit review. An edit-only hook
  runs too early to replace one final \`post_edit_review\` with verification evidence.
- Use \`session_memory\` to recall or explicitly save session-local working
  memory. Auto-recorded \`viewed\` entries are Codexa-derived; agent claims stay
  agent-asserted and must not be promoted into codebase facts.
- Use one \`search\` call for ambiguous natural-language tasks, then read the
  returned source targets instead of stacking context packets. Use
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
- Process: ${workflow.processKind ?? "unknown"}
- Entry score: ${workflow.entryScore ?? 0}
- Entry: \`${formatPathLine(workflow.entryPath, workflow.range?.startLine)}\`
- Terminals: ${(workflow.terminalFiles ?? []).slice(0, 8).map((file) => `\`${file}\``).join(", ") || "none"}
- Modules: ${(workflow.relatedModules ?? []).slice(0, 8).join(", ") || "none"}
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

1. Exact file, symbol, error, read-only check, or local edit: use source tools and tests with zero Codexa calls.
2. Ambiguous target: run \`search\` once; stop Codexa when raw evidence is sufficient.
3. For a non-trivial multi-file or high-risk edit, run \`change_plan\` with \`saveSnapshot: true\`, then edit and run its planned verification.
4. After planned verification, run one \`post_edit_review\` unless a true completion/Stop gate owns final review; an edit-only hook does not.
5. Run \`test_plan\` only when verification guidance remains unresolved; run \`proof_card\` only for policy, audit, release, or formal handoff proof.
6. Use \`capabilities\` only for a concretely triggered non-core operation.

## Module Playbooks

${index.modules.slice(0, 20).map((module) => `- \`playbooks/${moduleArtifactFileName(module)}\` - ${module.files.length} files, rank ${module.rank.toFixed(2)}`).join("\n")}
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
- Read the concrete source file directly once the target is known.
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
4. After planned verification, run one \`post_edit_review\` if a saved snapshot
   needs final drift accountability and no completion/Stop gate owns it.
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

## Packet Summary

- Kind: ${module.clusterKind ?? "path"}
- Relations: ${module.relationCount ?? 0} total, ${module.crossModuleRelationCount ?? 0} cross-module
- Top symbols: ${(module.topSymbols ?? []).slice(0, 8).map((symbol) => `\`${symbol}\``).join(", ") || "none"}
- Workflows: ${(module.workflows ?? []).slice(0, 6).join(", ") || "none"}
- Tests: ${(module.tests ?? []).slice(0, 6).map((file) => `\`${file}\``).join(", ") || "none"}
- Risks: ${(module.risks ?? []).slice(0, 6).join(", ") || "none"}

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

function evidenceCountText(counts: Partial<Record<string, number>> | undefined): string {
  const entries = Object.entries(counts ?? {})
    .filter(([, value]) => (value ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? entries.map(([key, value]) => `${key} ${value ?? 0}`).join(", ") : "none";
}

function roundNumber(value: number): number {
  return Number(value.toFixed(4));
}

function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

function workflowNodeId(id: string): string {
  return `workflow:${id}`;
}

function moduleNodeId(id: string): string {
  return `module:${id}`;
}

function uniqueGraphFiles(files: string[]): string[] {
  return [...new Set(files.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function dedupeGraphExportEdges(edges: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const edge of edges) {
    const key = String(edge.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edge);
  }
  return result;
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
