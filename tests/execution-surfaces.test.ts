import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { extractWorkflowTraces } from "../src/graph.js";
import { buildIndex } from "../src/indexer.js";
import { MCP_TOOL_NAMES } from "../src/mcp/tool-registry.js";
import { parseFile } from "../src/parser.js";
import type { CodexaIndex, FileFact, SymbolFact, TestEdgeFact } from "../src/types.js";

const COMMANDER_MARKER = "codexa:commander-command";
const MCP_MARKER = "codexa:mcp-tool";

it("indexes literal Commander and MCP handlers as bounded execution workflows", async () => {
  const repo = await createExecutionSurfaceRepo();
  try {
    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    const inlineCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "inline");
    const namedCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "named");
    const realCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "real");
    const splitCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "split");
    const castCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "cast");
    const scopedCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "scoped-real");
    const aliasedCommand = executionSurface(index, "src/cli.ts", COMMANDER_MARKER, "aliased-real");
    const esmSingleton = executionSurface(index, "src/singleton-cli.ts", COMMANDER_MARKER, "singleton-esm");
    const namespaceSingleton = executionSurface(index, "src/singleton-cli.ts", COMMANDER_MARKER, "singleton-namespace");
    const cjsSingleton = executionSurface(index, "src/singleton-cjs.ts", COMMANDER_MARKER, "singleton-cjs");
    const cjsNamespaceSingleton = executionSurface(index, "src/singleton-cjs.ts", COMMANDER_MARKER, "singleton-cjs-namespace");
    const inlineTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_inline");
    const objectTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_object");
    const directTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_direct");
    const injectedTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_injected");
    const loopTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_loop_a");
    const scopedOptionsTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_scoped_options");
    const scopedObjectTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_scoped_object");
    const scopedLoopTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_scoped_loop_a");
    const directOptionsTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_options_direct");
    const directMixedTool = executionSurface(index, "src/mcp.ts", MCP_MARKER, "tool_mixed_direct");

    expect(inlineCommand).toMatchObject({ kind: "module", source: "typescript-syntax", confidence: "derived" });
    expect(inlineCommand.range?.startLine).toBeGreaterThan(0);
    expectCall(index, inlineCommand, "runInline");
    expectCall(index, namedCommand, "namedCommandHandler");
    expectCall(index, realCommand, "runInline");
    expectCall(index, splitCommand, "runInline");
    expectCall(index, castCommand, "namedCommandHandler");
    expectCall(index, scopedCommand, "runInline");
    expectCall(index, aliasedCommand, "runInline");
    expectCall(index, esmSingleton, "runInline");
    expectCall(index, namespaceSingleton, "runInline");
    expect(cjsSingleton).toMatchObject({ source: "typescript-syntax", confidence: "derived" });
    expect(cjsNamespaceSingleton).toMatchObject({ source: "typescript-syntax", confidence: "derived" });
    expectCall(index, inlineTool, "runTool");
    expectCall(index, objectTool, "workflowHandler");
    expectCall(index, directTool, "directHandler");
    expectCall(index, injectedTool, "directHandler");
    expectCall(index, loopTool, "runTool");
    expectCall(index, scopedOptionsTool, "runTool");
    expectCall(index, scopedObjectTool, "workflowHandler");
    expectCall(index, scopedLoopTool, "runTool");
    expectCall(index, directOptionsTool, "runTool");
    expectCall(index, directMixedTool, "runTool");

    const optionParser = index.symbols.find((symbol) => symbol.path === "src/handlers.ts" && symbol.name === "optionParser");
    const buildConfig = index.symbols.find((symbol) => symbol.path === "src/handlers.ts" && symbol.name === "buildConfig");
    expect(index.graphEdges.some((edge) => edge.fromSymbolId === inlineCommand.id && edge.toSymbolId === optionParser?.id)).toBe(false);
    expect(index.graphEdges.some((edge) => edge.fromSymbolId === inlineTool.id && edge.toSymbolId === buildConfig?.id)).toBe(false);

    expect(index.symbols.some((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && symbol.name === "parent-only")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && symbol.name === "dynamic-command")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && ["wrong", "fake"].includes(symbol.name))).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(MCP_MARKER) && symbol.name === "dynamic-tool")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(MCP_MARKER) && symbol.name === "fake-tool")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(MCP_MARKER) && symbol.name === "false-member-link")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && ["shadowed-local-root", "shadowed-local-block", "shadowed-alias", "shadowed-constructor"].includes(symbol.name))).toBe(false);
    expect(index.symbols.filter((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && symbol.name === "aliased-real")).toHaveLength(1);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(MCP_MARKER) && [
      "shadowed-mcp-server",
      "shadowed-mcp-server-block",
      "shadowed-mcp-alternate",
      "shadowed-mcp-helper",
      "shadowed-mcp-object-helper",
      "shadowed-mcp-loop",
      "shadowed-mcp-options",
      "shadowed-mcp-container-as-server",
      "shadowed-mcp-mixed-container",
      "shadowed-mcp-mixed-direct",
      "shadowed-mcp-inline-mixed"
    ].includes(symbol.name))).toBe(false);
    expect(index.symbols.some((symbol) => symbol.decorators.includes(COMMANDER_MARKER) && ["shadowed-singleton", "wrong-cjs-package", "shadowed-require"].includes(symbol.name))).toBe(false);
    expect(index.symbols.some((symbol) =>
      symbol.decorators.some((marker) => marker === COMMANDER_MARKER || marker === MCP_MARKER)
      && /[\u0000-\u001f\u007f]/u.test(symbol.name)
    )).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "tests/registrations.test.ts" && symbol.decorators.some((marker) => marker === COMMANDER_MARKER || marker === MCP_MARKER))).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "src/unrelated.ts" && symbol.decorators.includes(COMMANDER_MARKER))).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "src/unrelated.ts" && symbol.decorators.includes(MCP_MARKER))).toBe(false);

    const commandWorkflow = index.workflows.find((workflow) => workflow.entrySymbolId === inlineCommand.id);
    const toolWorkflow = index.workflows.find((workflow) => workflow.entrySymbolId === inlineTool.id);
    expect(commandWorkflow).toMatchObject({ title: "command inline", workflowKind: "module", confidence: "derived" });
    expect(commandWorkflow?.relatedFiles).toEqual(expect.arrayContaining(["src/cli.ts", "src/handlers.ts", "tests/handlers.test.ts"]));
    expect(commandWorkflow?.tests).toContain("tests/handlers.test.ts");
    expect(commandWorkflow?.steps.find((step) => step.path === "tests/handlers.test.ts")?.confidence).toBe("derived");
    expect(toolWorkflow).toMatchObject({ title: "MCP tool tool_inline", workflowKind: "module", confidence: "derived" });
    expect(toolWorkflow?.relatedFiles).toContain("src/handlers.ts");

    const second = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    expect(executionSignature(second)).toEqual(executionSignature(index));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("recognizes every production MCP registration from a cold source parse", async () => {
  const absolutePath = fileURLToPath(new URL("../src/mcp/tools.ts", import.meta.url));
  const metadata = await stat(absolutePath);
  const parsed = await parseFile({
    repoRoot: path.dirname(path.dirname(absolutePath)),
    relativePath: "src/mcp/tools.ts",
    absolutePath,
    dirty: false,
    sizeBytes: metadata.size,
    snapshotId: "production-mcp-registration-contract",
    indexedAt: "2026-08-04T00:00:00.000Z"
  });
  const discovered = parsed.symbols
    .filter((symbol) => symbol.decorators.includes(MCP_MARKER))
    .map((symbol) => symbol.name)
    .sort();

  expect(parsed.parserErrors).toEqual([]);
  expect(discovered).toEqual([...MCP_TOOL_NAMES].sort());
});

it("keeps derived execution surfaces below coexisting route, job, and manifest workflows despite many indirect tests", async () => {
  const repo = await createExecutionSurfaceRepo();
  try {
    const indexed = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    const sourceFile = indexed.files.find((file) => file.path === "src/cli.ts")!;
    const sourceSymbol = executionSurface(indexed, "src/cli.ts", COMMANDER_MARKER, "inline");
    const files = [
      ...indexed.files.map((file) => ({ ...file, rank: 0 })),
      syntheticFile(sourceFile, "src/route.py"),
      syntheticFile(sourceFile, "src/job.py"),
      syntheticFile(sourceFile, "packages/tool.json")
    ];
    const route = syntheticEntry(sourceSymbol, "route-entry", "src/route.py", "route", []);
    const job = syntheticEntry(sourceSymbol, "job-entry", "src/job.py", "function", ["task"]);
    const manifest = syntheticEntry(sourceSymbol, "manifest-entry", "packages/tool.json", "node", []);
    const indirectTests = Array.from({ length: 12 }, (_, index) => syntheticTestEdge(indexed, `tests/indirect-${index}.test.ts`, "src/handlers.ts", "authoritative"));
    const directRouteTest = syntheticTestEdge(indexed, "tests/route.test.ts", route.path, "authoritative");
    const workflows = extractWorkflowTraces({
      ...indexed,
      files,
      symbols: [...indexed.symbols, route, job, manifest],
      testEdges: [...indirectTests, directRouteTest]
    });
    const executionWorkflows = workflows.filter((workflow) => workflow.title.startsWith("command ") || workflow.title.startsWith("MCP tool "));
    const established = [
      workflows.find((workflow) => workflow.entrySymbolId === route.id),
      workflows.find((workflow) => workflow.entrySymbolId === job.id),
      workflows.find((workflow) => workflow.entrySymbolId === manifest.id)
    ];
    const highestExecutionRank = Math.max(...executionWorkflows.map((workflow) => workflow.rank));

    expect(executionWorkflows.length).toBeGreaterThan(0);
    expect(established.every(Boolean)).toBe(true);
    expect(established.map((workflow) => workflow!.rank)).toEqual([10, 7, 6]);
    expect(highestExecutionRank).toBe(5);
    expect(established.every((workflow) => workflow!.rank > highestExecutionRank)).toBe(true);
    expect(workflows.find((workflow) => workflow.entrySymbolId === route.id)?.steps.find((step) => step.path === directRouteTest.path)?.confidence).toBe("authoritative");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("caps execution surfaces and handler calls in deterministic source order", async () => {
  const repo = await createExecutionSurfaceRepo();
  try {
    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    const bulk = index.symbols.filter((symbol) => symbol.path === "src/many-cli.ts" && symbol.decorators.includes(COMMANDER_MARKER));
    expect(bulk).toHaveLength(64);
    expect(bulk.map((symbol) => symbol.name)).toEqual(Array.from({ length: 64 }, (_, index) => `bulk-${index}`));
    expect(bulk.some((symbol) => symbol.name === "bulk-64")).toBe(false);
    expect(index.workflows.find((workflow) => workflow.entrySymbolId === bulk[0]?.id)?.truncation?.executionSurfaces).toEqual({ total: 70, returned: 64 });

    const capped = executionSurface(index, "src/capped-cli.ts", COMMANDER_MARKER, "capped");
    const handlerEdges = index.graphEdges.filter(
      (edge) => edge.edgeKind === "CALLS" && edge.fromSymbolId === capped.id && edge.toPath === "src/handlers.ts"
    );
    expect(handlerEdges).toHaveLength(15);
    const workflow = index.workflows.find((candidate) => candidate.entrySymbolId === capped.id);
    expect(workflow?.steps.filter((step) => step.kind === "call")).toHaveLength(15);
    expect(workflow?.steps).toHaveLength(17);
    expect(workflow?.truncation?.steps).toEqual({ total: 22, returned: 16 });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function executionSurface(index: CodexaIndex, filePath: string, marker: string, name: string): SymbolFact {
  const symbol = index.symbols.find(
    (candidate) => candidate.path === filePath && candidate.name === name && candidate.decorators.includes(marker)
  );
  expect(symbol, `${marker} ${name} in ${filePath}`).toBeTruthy();
  return symbol!;
}

function expectCall(index: CodexaIndex, surface: SymbolFact, targetName: string): void {
  const target = index.symbols.find((symbol) => symbol.path === "src/handlers.ts" && symbol.name === targetName);
  expect(target, `handler ${targetName}`).toBeTruthy();
  const edge = index.graphEdges.find(
    (candidate) => candidate.edgeKind === "CALLS" && candidate.fromSymbolId === surface.id && candidate.toSymbolId === target?.id
  );
  expect(edge).toMatchObject({ fromKind: "symbol", toKind: "symbol", confidence: "derived" });
  expect(edge?.range?.startLine).toBeGreaterThan(0);
}

function executionSignature(index: CodexaIndex): { symbols: string[]; edges: string[]; workflows: string[] } {
  const surfaceIds = new Set(index.symbols.filter((symbol) => symbol.decorators.some((marker) => marker === COMMANDER_MARKER || marker === MCP_MARKER)).map((symbol) => symbol.id));
  return {
    symbols: [...surfaceIds].sort(),
    edges: index.graphEdges.filter((edge) => Boolean(edge.fromSymbolId && surfaceIds.has(edge.fromSymbolId))).map((edge) => edge.id).sort(),
    workflows: index.workflows.filter((workflow) => Boolean(workflow.entrySymbolId && surfaceIds.has(workflow.entrySymbolId))).map((workflow) => workflow.id).sort()
  };
}

function syntheticFile(source: FileFact, filePath: string): FileFact {
  return { ...source, id: `file:${filePath}`, path: filePath, language: filePath.endsWith(".py") ? "python" : "json", rank: 0, test: false };
}

function syntheticEntry(source: SymbolFact, id: string, filePath: string, kind: SymbolFact["kind"], decorators: string[]): SymbolFact {
  return { ...source, id, path: filePath, name: id, qualifiedName: id, kind, decorators, confidence: "derived" };
}

function syntheticTestEdge(index: CodexaIndex, testPath: string, targetPath: string, confidence: TestEdgeFact["confidence"]): TestEdgeFact {
  return {
    id: `test:${testPath}:${targetPath}`,
    type: "TestEdge",
    path: testPath,
    targetPath,
    reason: `imports ${targetPath}`,
    source: confidence === "heuristic" ? "heuristic" : "tree-sitter",
    confidence,
    snapshotId: index.snapshot.snapshotId,
    indexedAt: index.snapshot.indexedAt
  };
}

async function createExecutionSurfaceRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-execution-surfaces-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  const cappedHandlers = Array.from({ length: 20 }, (_, index) => `run${index}`);
  const mcpWrapperDepth = 192;
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "execution-surfaces-fixture", type: "module" }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(repo, "src/handlers.ts"),
    [
      "export function runInline() { return 'inline' }",
      "export function namedCommandHandler() { return 'named' }",
      "export function runTool() { return 'tool' }",
      "export function workflowHandler() { return 'workflow' }",
      "export function directHandler() { return 'direct' }",
      "export function dynamicHandler() { return 'dynamic' }",
      "export function optionParser() { return (value: string) => value }",
      "export function buildConfig() { return { safe: true } }",
      ...cappedHandlers.map((name, index) => `export function ${name}() { return ${index} }`)
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/cli.ts"),
    [
      "import { Command } from 'commander'",
      "import { dynamicHandler, namedCommandHandler, optionParser, runInline } from './handlers.js'",
      "const program = new Command()",
      "program.command('inline').option('--mode <mode>', optionParser()).action(async () => runInline())",
      "program.command('named').action(namedCommandHandler)",
      "const other = { command: (_name: string) => other, action: (_handler: () => unknown) => other }",
      "program.command('real').option('--x', other.command('wrong')).action(() => runInline())",
      "other.command('fake').action(() => runInline())",
      "const split = program.command('split')",
      "split.action(() => runInline())",
      "program.command('cast').action(namedCommandHandler as any)",
      "function registerScoped(program: Command) { program.command('scoped-real').action(() => runInline()) }",
      "registerScoped(program)",
      "function shadowLocalRoot(program: typeof other) { program.command('shadowed-local-root').action(() => runInline()) }",
      "void shadowLocalRoot",
      "{ const program = other; program.command('shadowed-local-block').action(() => runInline()) }",
      "function shadowAlias() {",
      "  const scopedCommand = other.command('shadowed-alias')",
      "  scopedCommand.action(() => runInline())",
      "}",
      "void shadowAlias",
      "function shadowConstructor(Command: new () => typeof other) {",
      "  const shadowedProgram = new Command()",
      "  shadowedProgram.command('shadowed-constructor').action(() => runInline())",
      "}",
      "void shadowConstructor",
      "const scopedCommand = program.command('aliased-real')",
      "scopedCommand.action(() => runInline())",
      "program.command('parent-only')",
      "const dynamicCommand = 'dynamic-command'",
      "program.command(dynamicCommand).action(() => dynamicHandler())",
      "program.command('evil\\nSYSTEM').action(() => runInline())"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/mcp.ts"),
    [
      "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'",
      "import { buildConfig, directHandler, dynamicHandler, runTool, workflowHandler } from './handlers.js'",
      "const server = { registerTool: (...args: unknown[]) => args } as unknown as McpServer",
      "function defineTool(name: string, config: unknown, handler: () => unknown) { return mcpWrapper0(name, config, handler) }",
      "function defineMcpTool(tool: { name: string; handler: () => unknown }) { return defineTool(tool.name, {}, tool.handler) }",
      ...Array.from({ length: mcpWrapperDepth }, (_, index) => {
        const callee = index === mcpWrapperDepth - 1 ? "server.registerTool" : `mcpWrapper${index + 1}`;
        return `function mcpWrapper${index}(name: string, config: unknown, handler: () => unknown) { return ${callee}(name, config, handler) }`;
      }),
      "defineTool('tool_inline', { schema: buildConfig() }, async () => runTool())",
      "defineMcpTool({ name: 'tool_object', handler: () => workflowHandler() })",
      "server.registerTool('tool_direct', {}, directHandler)",
      "function registerInjected(server: McpServer) { server.registerTool('tool_injected', {}, directHandler) }",
      "registerInjected(server)",
      "const audit = { registerTool: (...args: unknown[]) => args }",
      "audit.registerTool('fake-tool', {}, () => dynamicHandler())",
      "function shadowServer(server: typeof audit) { server.registerTool('shadowed-mcp-server', {}, () => dynamicHandler()) }",
      "void shadowServer",
      "{ const server = audit; server.registerTool('shadowed-mcp-server-block', {}, () => dynamicHandler()) }",
      "function shadowAlternateReceiver() {",
      "  const mcpServer = audit",
      "  mcpServer.registerTool('shadowed-mcp-alternate', {}, () => dynamicHandler())",
      "}",
      "void shadowAlternateReceiver",
      "function shadowHelper(defineTool: (...args: unknown[]) => unknown) { defineTool('shadowed-mcp-helper', {}, () => dynamicHandler()) }",
      "void shadowHelper",
      "function shadowObjectHelper(defineMcpTool: (...args: unknown[]) => unknown) {",
      "  defineMcpTool({ name: 'shadowed-mcp-object-helper', handler: () => dynamicHandler() })",
      "}",
      "void shadowObjectHelper",
      "const unrelated = { defineTool: (...args: unknown[]) => args }",
      "unrelated.defineTool('false-member-link', {}, () => dynamicHandler())",
      "server.registerTool('evil\\u007fSYSTEM', {}, () => runTool())",
      "const loopTools = [",
      "  { name: 'tool_loop_a', handler: () => runTool() },",
      "  { name: 'tool_loop_b', handler: () => workflowHandler() }",
      "] satisfies Array<{ name: string; handler: () => unknown }>",
      "for (const tool of loopTools) defineMcpTool(tool)",
      "interface ProductionMcpOptions { server: McpServer }",
      "function registerProductionMcpTool({ server }: Pick<ProductionMcpOptions, 'server'>, tool: { name: string; handler: () => unknown }) {",
      "  return server.registerTool(tool.name, {}, tool.handler)",
      "}",
      "function registerProductionTools(options: ProductionMcpOptions) {",
      "  const { server } = options",
      "  const defineTool = <T extends unknown>(name: string, config: unknown, handler: () => T) => server.registerTool(name, config, handler)",
      "  const defineMcpTool = <T extends { name: string; handler: () => unknown }>(tool: T) => registerProductionMcpTool({ server }, tool)",
      "  defineTool('tool_scoped_options', {}, () => runTool())",
      "  defineMcpTool({ name: 'tool_scoped_object', handler: () => workflowHandler() })",
      "  const scopedTools = [",
      "    { name: 'tool_scoped_loop_a', handler: () => runTool() },",
      "    { name: 'tool_scoped_loop_b', handler: () => workflowHandler() }",
      "  ] satisfies Array<{ name: string; handler: () => unknown }>",
      "  for (const tool of scopedTools) defineMcpTool(tool)",
      "}",
      "registerProductionTools({ server })",
      "function registerProductionDirect(options: Pick<ProductionMcpOptions, 'server'>) {",
      "  return options.server.registerTool('tool_options_direct', {}, () => runTool())",
      "}",
      "void registerProductionDirect",
      "interface NonMcpOptions { server: typeof audit }",
      "function registerShadowedOptions(options: NonMcpOptions) {",
      "  const { server } = options",
      "  const defineTool = (name: string, config: unknown, handler: () => unknown) => server.registerTool(name, config, handler)",
      "  defineTool('shadowed-mcp-options', {}, () => dynamicHandler())",
      "}",
      "void registerShadowedOptions",
      "function rejectContainerAsReceiver(server: ProductionMcpOptions) {",
      "  server.registerTool('shadowed-mcp-container-as-server', {}, () => dynamicHandler())",
      "}",
      "void rejectContainerAsReceiver",
      "interface MixedServerOptions { server: typeof audit; mcpServer: McpServer }",
      "function rejectMixedContainer(options: MixedServerOptions) {",
      "  const { server } = options",
      "  server.registerTool('shadowed-mcp-mixed-container', {}, () => dynamicHandler())",
      "}",
      "void rejectMixedContainer",
      "function registerMixedDirect(options: MixedServerOptions) {",
      "  options.server.registerTool('shadowed-mcp-mixed-direct', {}, () => dynamicHandler())",
      "  options.mcpServer.registerTool('tool_mixed_direct', {}, () => runTool())",
      "}",
      "void registerMixedDirect",
      "function rejectInlineMixed({ server }: { server: typeof audit; mcpServer: McpServer }) {",
      "  server.registerTool('shadowed-mcp-inline-mixed', {}, () => dynamicHandler())",
      "}",
      "void rejectInlineMixed",
      "function shadowLoopTools(defineMcpTool: (...args: unknown[]) => unknown) {",
      "  const loopTools = [{ name: 'shadowed-mcp-loop', handler: () => dynamicHandler() }]",
      "  for (const tool of loopTools) defineMcpTool(tool)",
      "}",
      "void shadowLoopTools",
      "const dynamicTool = 'dynamic-tool'",
      "defineTool(dynamicTool, {}, () => dynamicHandler())"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/singleton-cli.ts"),
    [
      "import { program as singletonProgram } from 'commander'",
      "import * as commanderNamespace from 'commander'",
      "import { runInline } from './handlers.js'",
      "singletonProgram.command('singleton-esm').action(() => runInline())",
      "commanderNamespace.program.command('singleton-namespace').action(() => runInline())",
      "function shadow(singletonProgram: { command(name: string): any }) {",
      "  singletonProgram.command('shadowed-singleton').action(() => runInline())",
      "}",
      "void shadow"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/singleton-cjs.ts"),
    [
      "const { program: cjsProgram } = require('commander')",
      "const commanderModule = require('commander')",
      "const { program: wrongProgram } = require('not-commander')",
      "function cjsHandler() { return 'ok' }",
      "cjsProgram.command('singleton-cjs').action(cjsHandler)",
      "commanderModule.program.command('singleton-cjs-namespace').action(cjsHandler)",
      "wrongProgram.command('wrong-cjs-package').action(cjsHandler)"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/shadowed-require.ts"),
    [
      "function require(_name: string) { return { program: { command: () => ({ action: () => undefined }) } } }",
      "const { program } = require('commander')",
      "program.command('shadowed-require').action(() => 1)"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/unrelated.ts"),
    [
      "const builder = { command: (_name: string) => builder, action: (_handler: () => unknown) => builder }",
      "const defineTool = (_name: string, _config: unknown, handler: () => unknown) => handler",
      "builder.command('not-commander').action(() => 1)",
      "defineTool('not-mcp', {}, () => 1)"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/many-cli.ts"),
    [
      "import { Command } from 'commander'",
      "import { runInline } from './handlers.js'",
      "const program = new Command()",
      ...Array.from({ length: 70 }, (_, index) => `program.command('bulk-${index}').action(() => runInline())`)
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/capped-cli.ts"),
    [
      "import { Command } from 'commander'",
      `import { ${cappedHandlers.join(", ")} } from './handlers.js'`,
      "const program = new Command()",
      "program.command('capped').action(() => {",
      ...cappedHandlers.map((name) => `  ${name}()`),
      "})"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/handlers.test.ts"),
    "import { runInline } from '../src/handlers.js'\nexport function testHandlers() { return runInline() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/registrations.test.ts"),
    [
      "import { Command } from 'commander'",
      "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'",
      "const program = new Command()",
      "const server = {} as McpServer",
      "program.command('test-command').action(() => 1)",
      "server.registerTool('test-tool', {}, () => 1)"
    ].join("\n") + "\n",
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}
