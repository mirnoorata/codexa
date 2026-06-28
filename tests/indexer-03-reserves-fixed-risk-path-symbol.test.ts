import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitState } from "../src/git.js";
import { buildIndex, buildIndexLocked, getFreshness, loadIndex } from "../src/indexer.js";
import { MAX_INDEXED_SOURCE_BYTES } from "../src/repo-files.js";
import { validateChangePlanTargetCandidate } from "../src/query/change-plan.js";
import { postEditDecision } from "../src/query/post-edit/decision.js";
import { postEditReviewWithTrustedRunnerReports } from "../src/query/post-edit.js";
import { loadExternalRiskSignals, MAX_RISK_REPORT_BYTES } from "../src/risk-ingest.js";
import { recordSessionMemory } from "../src/session-memory.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import type { AutoVerifyCommandReport } from "../src/autoverify.js";
import {
  callersQuery,
  calleesQuery,
  changePlanQuery,
  contextPackQuery,
  dependencyPathQuery,
  diffImpactQuery,
  fileContextQuery,
  focusBriefQuery,
  impactQuery,
  placeholderReportQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  statusQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "../src/queries.js";
import { createFixtureRepo, createDocFixtureRepo, createBroadWorkflowFixtureRepo, createVerificationCoverageFixtureRepo, createSemanticDefaultRepo, createManifestGateFixtureRepo, createDottedReferenceFixtureRepo, createManifestLocalityFixtureRepo, mkdirp } from "./indexer-fixtures.js";
describe("Codexa indexer", () => {
it("reserves fixed risk-path symbol reports after known custom symbol reports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-path-symbol-fixed-reserve-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `custom-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "manual-symbol-tool",
          language: "typescript",
          symbols: [{ id: `custom-${index}`, name: `custom${index}`, qualifiedName: `custom${index}`, kind: "function", path: "src/app.ts", line: 1 }]
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-path-symbol-fixed-reserve"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(
      path.join(repo, ".codex/static-analysis/risks.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "risk-path-symbol", name: "riskPathSymbol", qualifiedName: "riskPathSymbol", kind: "function", path: "src/app.ts", line: 2 }]
      }),
      "utf8"
    );

    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.symbols.some((symbol) => symbol.qualifiedName === "riskPathSymbol" && symbol.source === "static-analysis")).toBe(true);
    expect(refreshed.freshness.externalSymbolReportHashes?.[".codex/static-analysis/risks.json"]).toBeTruthy();
  });

it("does not surface large generic risk reports as symbol report parser errors", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-large-risk-no-symbol-error-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/manual-risk.json"),
      JSON.stringify({
        risks: [{ path: "src/app.ts", signal: "manual-large-risk", reason: "manual", score: 5 }],
        padding: "x".repeat(2 * 1024 * 1024 + 1)
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "large-risk-no-symbol-error"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });

    expect(index.risks.some((risk) => risk.signal === "manual-large-risk")).toBe(true);
    expect(index.parserErrors.some((error) => error.path === ".codex/static-analysis/manual-risk.json" && error.message.includes("external symbol report"))).toBe(false);
  });

it("does not surface large generic non-report JSON as a symbol report diagnostic", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-large-generic-json-no-symbol-error-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/notes.json"), JSON.stringify({ note: "not a report", padding: "x".repeat(2 * 1024 * 1024 + 1) }), "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "large-generic-json-no-symbol-error"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/notes.json")).toBe(false);
    expect(index.parserErrors.some((error) => error.path === ".codex/static-analysis/notes.json" && error.message.includes("external symbol report"))).toBe(false);
  });

it("dedupes external risks within a report before applying the per-report cap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-same-report-dedupe-cap-"));
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    const duplicateRisks = Array.from({ length: 6000 }, () => ({ path: "src/app.ts", signal: "duplicate", reason: "same", score: 1 }));
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: [...duplicateRisks, { path: "src/app.ts", signal: "unique-same-report", reason: "late", score: 3 }] }), "utf8");

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-05-31T00:00:00.000Z");

    expect(risks.some((risk) => risk.signal === "duplicate")).toBe(true);
    expect(risks.some((risk) => risk.signal === "unique-same-report")).toBe(true);
  });

it("indexes placeholder and dummy code/data and tracks placeholder risk deltas", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-placeholder-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, "src/generated"));
    await mkdirp(path.join(repo, "service"));
    await mkdirp(path.join(repo, "config"));
    await mkdirp(path.join(repo, "broken"));
    await mkdirp(path.join(repo, "docs"));
    await mkdirp(path.join(repo, "tests"));
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/ready.ts"), "export function ready() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "src/formatted-empty.ts"), "export function formattedEmpty() {\n}\n", "utf8");
    await writeFile(path.join(repo, "src/methods.ts"), "export class Box { constructor() {} reset() {} }\nexport const oneArg = value => {}\n", "utf8");
    await writeFile(
      path.join(repo, "src/parameter-property.ts"),
      "interface ClientOptions { endpoint: string }\nexport class Client { constructor(private readonly options: ClientOptions) {} }\nexport class MultilineClient {\n  constructor(private readonly options: ClientOptions) {\n  }\n}\n",
      "utf8"
    );
    await writeFile(path.join(repo, "src/block-comment.ts"), "/**\n * TODO: replace temporary parser fallback\n */\nexport const ready = true\n", "utf8");
    await writeFile(path.join(repo, "src/uppercase.ts"), "export const token = 'TODO'\n", "utf8");
    await writeFile(path.join(repo, "src/url.ts"), "export const docsUrl = 'https://example.com/TODO'\n", "utf8");
    await writeFile(path.join(repo, "src/regex-detector.ts"), "export const marker = /['\"`](?:todo|placeholder|not implemented)['\"`]/giu\n", "utf8");
    await writeFile(path.join(repo, "src/generated/client.ts"), "export function generatedLater() { throw new Error('not implemented') }\n", "utf8");
    await writeFile(
      path.join(repo, "src/commented.ts"),
      [
        "// throw new Error('not implemented')",
        "export const example = \"throw new Error('not implemented')\"",
        "export const block = '/* TODO: example */'",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repo, "src/existing.ts"),
      [
        "export function unfinished() { throw new Error('TODO: implement real behavior') }",
        "export function emptyHandler() {}",
        "export const dummyUser = { email: 'example@example.com' }",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(repo, "service/work.py"), "def later():\n    raise NotImplementedError('not implemented yet')\n\ndef marker():\n    pass\n", "utf8");
    await writeFile(path.join(repo, "service/strings.py"), "docs_url = 'https://example.com/#TODO'\n# raise NotImplementedError('later')\nreal_value = 1\n", "utf8");
    await writeFile(path.join(repo, "config/seeds.json"), JSON.stringify({ placeholderToken: "REPLACE_ME", real: true }, null, 2), "utf8");
    await writeFile(path.join(repo, "config/broken.json"), "{\"notManifest\": true,\n", "utf8");
    await writeFile(path.join(repo, "broken/package.json"), "{\"placeholderToken\":\"REPLACE_ME\",\n", "utf8");
    await writeFile(path.join(repo, "docs/todo.md"), "TODO document the placeholder report\n", "utf8");
    await writeFile(path.join(repo, "tests/stub.test.ts"), "it('keeps fixture placeholder text', () => {}) // TODO test fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo });
    expect(index.risks.some((risk) => risk.path === "src/existing.ts" && risk.signal === "placeholder.not-implemented" && risk.confidence === "derived")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/existing.ts" && risk.signal === "placeholder.no-op-body")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/formatted-empty.ts" && risk.signal === "placeholder.no-op-body")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/methods.ts" && risk.signal === "placeholder.no-op-body")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/parameter-property.ts")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "src/block-comment.ts" && risk.signal === "placeholder.todo-comment")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/uppercase.ts" && risk.signal === "placeholder.dummy-literal")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/existing.ts" && risk.signal === "placeholder.dummy-data")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/work.py" && risk.signal === "placeholder.not-implemented")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "config/seeds.json" && risk.signal === "placeholder.dummy-literal")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "broken/package.json" && risk.signal === "placeholder.dummy-literal")).toBe(true);
    expect(index.parserErrors.some((error) => error.path === "config/broken.json")).toBe(true);
    expect(index.parserErrors.some((error) => error.path === "broken/package.json")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/url.ts" || risk.path === "src/regex-detector.ts" || risk.path === "service/strings.py")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "src/commented.ts" && risk.signal === "placeholder.placeholder-comment")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/commented.ts" && risk.signal === "placeholder.not-implemented")).toBe(false);
    expect(index.files.find((file) => file.path === "src/existing.ts")?.riskScore ?? 0).toBeGreaterThan(index.files.find((file) => file.path === "tests/stub.test.ts")?.riskScore ?? 0);

    const defaultReport = await placeholderReportQuery(repo, { limit: 20 }, { autoRefresh: false });
    const defaultData = defaultReport.data as { findings: Array<{ path: string }>; excludedByFilter: number };
    expect(defaultData.findings.some((finding) => finding.path === "src/existing.ts")).toBe(true);
    expect(defaultData.findings.some((finding) => finding.path.startsWith("tests/") || finding.path.startsWith("docs/") || finding.path.includes("/generated/"))).toBe(false);
    expect(defaultData.excludedByFilter).toBeGreaterThanOrEqual(3);

    const report = await placeholderReportQuery(repo, { includeTests: true, includeDocs: true, includeGenerated: true, limit: 50 }, { autoRefresh: false });
    const reportData = report.data as { findings: Array<{ path: string }>; categories: Record<string, number>; hiddenByLimit: number };
    expect(report.text).toContain("Codexa placeholder report");
    expect(report.text).toContain("placeholder.not-implemented");
    expect(report.text).toContain("config/seeds.json");
    expect(reportData.findings.some((finding) => finding.path === "src/generated/client.ts")).toBe(true);
    expect(reportData.findings.some((finding) => finding.path === "docs/todo.md")).toBe(true);
    expect(reportData.categories["not-implemented"]).toBeGreaterThanOrEqual(2);
    expect(reportData.hiddenByLimit).toBe(0);
    expect(await readFile(path.join(repo, ".codex/codebase/placeholder-map.md"), "utf8")).toContain("Placeholder Map");
    const cliReport = execFileSync(process.execPath, [path.join(process.cwd(), "dist/cli.js"), "placeholder-report", repo, "--no-auto-refresh", "--limit", "5"], {
      encoding: "utf8"
    });
    expect(cliReport).toContain("Codexa placeholder report");

    await changePlanQuery(
      repo,
      {
        task: "replace ready implementation",
        files: ["src/ready.ts"],
        saveSnapshot: true,
        taskId: "placeholder-tracking"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "src/ready.ts"), "export function ready() { throw new Error('not implemented') }\nexport function readyAgain() { throw new Error('not implemented') }\n", "utf8");
    const review = await postEditReviewQuery(repo, { taskId: "placeholder-tracking", ranTests: [] }, { autoRefresh: true });
    expect(review.text).toContain("placeholder.not-implemented");
    expect(review.text).toContain("src/ready.ts");
    const reviewData = review.data as { riskDeltas: Array<{ path: string; before: { riskScore: number }; after: { riskScore: number }; newSignals: string[] }> };
    const readyDelta = reviewData.riskDeltas.find((delta) => delta.path === "src/ready.ts");
    expect(readyDelta?.before.riskScore).toBe(0);
    expect(readyDelta?.after.riskScore ?? 0).toBeGreaterThan(0);
    expect(readyDelta?.newSignals.filter((signal) => signal.includes("placeholder.not-implemented"))).toHaveLength(2);

    await changePlanQuery(repo, { task: "remove existing placeholders", files: ["src/existing.ts"], saveSnapshot: true, taskId: "placeholder-removal" }, { autoRefresh: true });
    await writeFile(path.join(repo, "src/existing.ts"), "export function finished() { return 'done' }\n", "utf8");
    const removal = await postEditReviewQuery(repo, { taskId: "placeholder-removal", ranTests: [] }, { autoRefresh: true });
    const removalData = removal.data as { riskDeltas: Array<{ path: string; removedSignals: string[] }> };
    expect(removalData.riskDeltas.find((delta) => delta.path === "src/existing.ts")?.removedSignals.some((signal) => signal.includes("placeholder."))).toBe(true);
  });

it("writes valid artifacts and reports dirty overlay freshness", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const readme = await readFile(path.join(repo, ".codex/codebase/README.md"), "utf8");
    const contract = await readFile(path.join(repo, ".codex/codebase/codex-contract.md"), "utf8");
    const relationalPackets = await readFile(path.join(repo, ".codex/codebase/relational-packets.md"), "utf8");
    const relationalPacketsJson = JSON.parse(await readFile(path.join(repo, ".codex/codebase/relational-packets.json"), "utf8"));
    const relationalGraphJson = JSON.parse(await readFile(path.join(repo, ".codex/codebase/relational-graph.json"), "utf8"));
    const summaryPrompts = (await readFile(path.join(repo, ".codex/codebase/packet-summary-prompts.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const facts = await readFile(path.join(repo, ".codex/codebase/facts.ndjson"), "utf8");
    expect(readme).toContain("Codexa Codebase Context");
    expect(readme).toContain("relational-packets.md");
    expect(readme).toContain("relational-packets.json");
    expect(readme).not.toContain(repo);
    expect(contract).toContain("Codexa Codex Contract");
    expect(contract).toContain("change_plan");
    expect(contract).toContain("post_edit_review");
    expect(contract).not.toContain(repo);
    expect(relationalPackets).toContain("# Relational Packets");
    expect(relationalPackets).toContain("Process packet:");
    expect(relationalPackets).toContain("## Cluster Packets");
    expect(relationalPackets).toContain("packet-summary-prompts.ndjson");
    expect(relationalPacketsJson.schemaVersion).toBe(1);
    expect(relationalPacketsJson.processPackets.some((packet: { title: string }) => packet.title.includes("route route_thing"))).toBe(true);
    expect(relationalPacketsJson.clusterPackets.some((packet: { clusterKind: string; summaryPrompt?: string }) => packet.clusterKind === "functional" && packet.summaryPrompt?.includes("using only cited files"))).toBe(true);
    expect(JSON.stringify(relationalPacketsJson)).not.toContain(repo);
    expect(relationalGraphJson.schemaVersion).toBe(1);
    expect(relationalGraphJson.nodes.some((node: { type: string; clusterKind?: string }) => node.type === "module" && node.clusterKind === "functional")).toBe(true);
    expect(relationalGraphJson.edges.some((edge: { kind: string }) => edge.kind === "CONTAINS")).toBe(true);
    expect(JSON.stringify(relationalGraphJson)).not.toContain(repo);
    expect(summaryPrompts.some((prompt: { kind: string; prompt: string }) => prompt.kind === "module" && prompt.prompt.includes("using only cited files"))).toBe(true);
    expect(facts.trim().split("\n").every((line) => JSON.parse(line))).toBe(true);

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 2 }\n", "utf8");
    const status = await statusQuery(repo);
    expect(status.freshness.stale).toBe(true);
    expect(status.freshness.reason).toBe("dirty-files-changed");

    await buildIndex({ repoRoot: repo });
    const fresh = await statusQuery(repo);
    expect(fresh.freshness.stale).toBe(false);
    expect(fresh.freshness.dirtyFiles).toContain("src/util.ts");

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 3 }\n", "utf8");
    const reedited = await statusQuery(repo);
    expect(reedited.freshness.stale).toBe(true);
    expect(reedited.freshness.reason).toBe("dirty-files-changed");
  });

it("does not follow symlinked source files outside the repository", async () => {
    const repo = await createFixtureRepo();
    const externalDir = await mkdtemp(path.join(os.tmpdir(), "codexa-outside-source-"));
    const externalSource = path.join(externalDir, "outside.ts");
    await writeFile(externalSource, "export const leakedOutsideSecret = 'do-not-index-this'\n", "utf8");
    await symlink(externalSource, path.join(repo, "src/outside-link.ts"));

    const index = await buildIndex({ repoRoot: repo });
    const artifact = await readFile(path.join(repo, ".codex/codebase/index.json"), "utf8");

    expect(index.files.some((file) => file.path === "src/outside-link.ts")).toBe(false);
    expect(index.freshness.dirtyFiles).toContain("src/outside-link.ts");
    expect(index.freshness.dirtyFileHashes["src/outside-link.ts"]).toBe("non-file");
    expect(artifact).not.toContain("leakedOutsideSecret");
    expect(artifact).not.toContain("do-not-index-this");
  });

it("does not credit a typecheck script whose body is a non-compiling tsc invocation", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-noncompiling-typecheck-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --help", build: "tsc --version" } }, null, 2), "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export const app = () => 1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.io", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(repo, { task: "touch app", files: ["src/app.ts"], changeType: "behavior", diff: false, limit: 6, saveSnapshot: true, taskId: "nc-tsc" }, { autoRefresh: false });
    await writeFile(path.join(repo, "src/app.ts"), "export const app = () => 2\n", "utf8");

    const review = await postEditReviewQuery(repo, { taskId: "nc-tsc", ranCommands: ["npm run typecheck", "npm run build"] }, { autoRefresh: true });
    const kinds = (review.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
    expect(kinds).not.toContain("typescript-syntax");
    expect(kinds).not.toContain("build");
  });

it("refuses the basename test-target fallback when the basename is ambiguous", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-ambiguous-test-target-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "pkg_a"), { recursive: true });
    await mkdir(path.join(repo, "pkg_b"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    // Two source files share a basename; the top-level test imports neither.
    await writeFile(path.join(repo, "pkg_a/handlers.py"), "def handle():\n    return 1\n");
    await writeFile(path.join(repo, "pkg_b/handlers.py"), "def handle():\n    return 2\n");
    await writeFile(path.join(repo, "tests/test_handlers.py"), "def test_handlers():\n    assert True\n");
    // A uniquely-named source remains linkable via the basename fallback.
    await writeFile(path.join(repo, "pkg_a/widget.py"), "def widget():\n    return 1\n");
    await writeFile(path.join(repo, "tests/test_widget.py"), "def test_widget():\n    assert True\n");
    // A scoped test path uniquely suffix-matches one of the duplicate basenames.
    await mkdir(path.join(repo, "src/api"), { recursive: true });
    await mkdir(path.join(repo, "src/admin"), { recursive: true });
    await mkdir(path.join(repo, "tests/api"), { recursive: true });
    await writeFile(path.join(repo, "src/api/scoped.py"), "def scoped():\n    return 1\n");
    await writeFile(path.join(repo, "src/admin/scoped.py"), "def scoped():\n    return 2\n");
    await writeFile(path.join(repo, "tests/api/test_scoped.py"), "def test_scoped():\n    assert True\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.io", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    const handlerEdges = index.testEdges.filter((edge) => edge.path === "tests/test_handlers.py" && edge.targetPath?.endsWith("handlers.py"));
    expect(handlerEdges).toEqual([]);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_widget.py" && edge.targetPath === "pkg_a/widget.py")).toBe(true);
    // Scoped suffix match binds to the in-scope source, not the other package's.
    expect(index.testEdges.some((edge) => edge.path === "tests/api/test_scoped.py" && edge.targetPath === "src/api/scoped.py")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/api/test_scoped.py" && edge.targetPath === "src/admin/scoped.py")).toBe(false);
  });

it("links a directory-named test to its unique source despite a basename collision", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-dir-named-test-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "tests"), { recursive: true });
    // The test is identified by its `tests/` directory, not a `.test`/`_test`
    // suffix, so its basename collides with the source's — the source is still
    // the unique non-test target.
    await writeFile(path.join(repo, "src/button.ts"), "export function button() { return 1 }\n");
    await writeFile(path.join(repo, "tests/button.ts"), "import { button } from '../src/button'\ntest('button', () => expect(button()).toBe(1))\n");

    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.io", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    expect(index.testEdges.some((edge) => edge.path === "tests/button.ts" && edge.targetPath === "src/button.ts")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/button.ts" && edge.targetPath === "tests/button.ts")).toBe(false);
  });

it("content-hashes dirty files including non-source and multi-MB ones (streamed)", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    // A multi-MB binary is now stream-hashed (under the raised per-file cap), so
    // it gets a content hash rather than a collision-prone metadata hash.
    await writeFile(path.join(repo, "large-output.bin"), Buffer.alloc(3 * 1024 * 1024 + 1, "a"));
    // Non-source config file: must be content-hashed so a same-length edit in the
    // same mtime tick still changes the hash (no silent drift reconciliation).
    await writeFile(path.join(repo, "app.yaml"), "flag: on\n");
    const status = await statusQuery(repo);

    expect(status.freshness.dirtyFiles).toContain("large-output.bin");
    expect(status.freshness.dirtyFileHashes["large-output.bin"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(status.freshness.dirtyFileHashes["app.yaml"]).toMatch(/^[0-9a-f]{40}$/u);

    // A same-length content change yields a different content hash.
    await writeFile(path.join(repo, "app.yaml"), "flag: no\n");
    const after = await statusQuery(repo);
    expect(after.freshness.dirtyFileHashes["app.yaml"]).toMatch(/^[0-9a-f]{40}$/u);
    expect(after.freshness.dirtyFileHashes["app.yaml"]).not.toBe(status.freshness.dirtyFileHashes["app.yaml"]);
  });

it("keeps high-severity placeholder findings in the bounded placeholder map", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-placeholder-map-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "docs"));
    await mkdirp(path.join(repo, "zz"));
    for (let index = 0; index < 170; index += 1) {
      await writeFile(path.join(repo, "docs", `todo-${String(index).padStart(3, "0")}.md`), "TODO document this low-risk note\n", "utf8");
    }
    await writeFile(path.join(repo, "zz/high.ts"), "export function highRiskLatePath() { throw new Error('not implemented') }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    await buildIndex({ repoRoot: repo });
    const placeholderMap = await readFile(path.join(repo, ".codex/codebase/placeholder-map.md"), "utf8");

    expect(placeholderMap).toContain("zz/high.ts");
    expect(placeholderMap).toContain("placeholder.not-implemented");
  });

it("writes and reuses a parse cache for unchanged files", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const cachePath = path.join(repo, ".codex/cache/codexa-parse-cache.json");
    const firstCache = JSON.parse(await readFile(cachePath, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(firstCache.entries)).toContain("src/api.ts");

    const poisoned = firstCache as {
      entries: Record<string, { result?: { symbols?: Array<{ path?: string }> } }>;
    };
    const firstApiSymbol = poisoned.entries["src/api.ts"]?.result?.symbols?.[0];
    if (firstApiSymbol) {
      firstApiSymbol.path = "src/poisoned.ts";
    }
    await writeFile(cachePath, `${JSON.stringify(poisoned)}\n`, "utf8");
    const rebuilt = await buildIndex({ repoRoot: repo });
    expect(rebuilt.symbols.some((symbol) => symbol.path === "src/poisoned.ts")).toBe(false);

    await buildIndex({ repoRoot: repo });
    const secondCache = JSON.parse(await readFile(cachePath, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(secondCache.entries).sort()).toEqual(Object.keys(firstCache.entries).sort());
  });

it("imports Semgrep and CodeQL reports without vendoring scanner code", async () => {
    const repo = await createFixtureRepo();
    const externalDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-"));
    const semgrepReport = path.join(externalDir, "semgrep-output.json");
    const codeqlReport = path.join(externalDir, "codeql-output.sarif");
    const genericReport = path.join(externalDir, "risks.json");
    await writeFile(
      semgrepReport,
      JSON.stringify({
        results: [
          {
            check_id: "semgrep.extra-auth",
            path: "service/app.py",
            start: { line: 8 },
            extra: { severity: "ERROR", message: "extra auth check" }
          }
        ]
      }),
      "utf8"
    );
    await writeFile(
      codeqlReport,
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: {
              driver: {
                name: "CodeQL",
                rules: [
                  {
                    id: "js/xss",
                    shortDescription: { text: "XSS risk" },
                    properties: {
                      precision: "high",
                      "problem.severity": "error",
                      "security-severity": "8.1",
                      tags: ["security", "external/cwe/cwe-079"]
                    }
                  }
                ]
              }
            },
            results: [
              {
                ruleId: "js/xss",
                level: "error",
                message: { text: "user-controlled HTML" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "web/src/Danger.tsx" },
                      region: { startLine: 1 }
                    }
                  },
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "/tmp/outside-codeql-result.ts" },
                      region: { startLine: 1 }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }),
      "utf8"
    );
    await writeFile(
      genericReport,
      JSON.stringify({ risks: [{ path: "src/ops.ts", signal: "generic.shell", severity: "HIGH", message: "external shell finding", line: 2 }] }),
      "utf8"
    );

    const summary = await updateStaticAnalysisReports(repo, {
      semgrepReports: [semgrepReport],
      codeqlReports: [codeqlReport],
      genericReports: [genericReport],
      index: true
    });
    expect(summary.text).toContain("Codexa static-analysis update");
    expect(summary.text).toContain("License boundary");
    expect(summary.reports).toHaveLength(3);
    expect(summary.staticRiskCount).toBeGreaterThanOrEqual(3);

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-04-12T00:00:00.000Z");
    expect(risks.some((risk) => risk.signal === "semgrep.extra-auth" && risk.path === "service/app.py" && risk.confidence === "derived")).toBe(true);
    const codeqlRisk = risks.find((risk) => risk.signal === "js/xss" && risk.path === "web/src/Danger.tsx");
    expect(codeqlRisk?.score).toBe(3);
    expect(codeqlRisk?.reason).toContain("CodeQL");
    expect(codeqlRisk?.reason).toContain("external/cwe/cwe-079");
    expect(risks.some((risk) => risk.path.includes("outside-codeql-result"))).toBe(false);
    expect(risks.some((risk) => risk.signal === "generic.shell" && risk.path === "src/ops.ts")).toBe(true);
    expect(summary.index?.risks.some((risk) => risk.signal === "js/xss" && risk.path === "web/src/Danger.tsx")).toBe(true);
  });

it("returns impact and test-plan evidence for mixed repos", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const cleanPlan = await testPlanQuery(repo, true, { autoRefresh: false });
    const cleanPlanData = cleanPlan.data as { actionability?: string; tests?: unknown[]; verificationCommands?: unknown[] };
    expect(cleanPlan.text).toContain("No targeted test plan");
    expect(cleanPlan.text).not.toContain("top-ranked files");
    expect(cleanPlanData.actionability).toBe("needs_target");
    expect(cleanPlanData.tests).toEqual([]);
    expect(cleanPlanData.verificationCommands).toEqual([]);

    const targetPlan = await testPlanQuery(repo, false, { autoRefresh: false, files: ["service/helpers.py"] });
    const targetPlanData = targetPlan.data as { actionability?: string; targetFiles?: string[]; tests?: Array<{ path: string }> };
    expect(targetPlanData.actionability).toBe("verify");
    expect(targetPlanData.targetFiles).toEqual(["service/helpers.py"]);
    expect(targetPlanData.tests?.map((test) => test.path)).toContain("tests/test_app.py");
    expect(targetPlan.text).toContain("Test plan for 1 target file");
    expect(targetPlan.text).toContain("tests/test_app.py");

    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const impact = await impactQuery(repo, { file: "service/helpers.py" }, { autoRefresh: true });
    expect(impact.text).toContain("auto-refreshed from dirty-files-changed");
    expect(impact.text).toContain("service/app.py");

    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    expect(plan.text).toContain("tests/test_app.py");
    expect(plan.text).toContain("authoritative;");
    expect(plan.text).toContain("Candidate test commands");
    expect(plan.text).toContain(`cd ${repo} && pytest tests/test_app.py`);
  });

it("surfaces prior outcome learning in test-plan recommendations", async () => {
    const repo = await createFixtureRepo();
    const outcomeDir = path.join(repo, ".codex/cache/codexa-outcomes");
    await mkdir(outcomeDir, { recursive: true });
    await writeFile(
      path.join(outcomeDir, "learned-test-outcome.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          outcomeId: "learned-test-outcome",
          verdict: "inspect",
          changedFiles: ["service/helpers.py"],
          reviewTargets: ["service/helpers.py"],
          missedLikelyTests: [{ path: "tests/test_app.py", reason: "previously missed route regression" }],
          testsNotRun: [{ path: "tests/test_app.py", reason: "not accounted for" }],
          recommendedTests: [{ path: "tests/test_app.py", reason: "recommended" }]
        },
        null,
        2
      ),
      "utf8"
    );
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: false });
    const data = plan.data as { outcomeLearning?: Array<{ path: string; evidence?: string[]; sources?: string[]; command?: string }> };

    expect(plan.text).toContain("Outcome learning:");
    expect(plan.text).toContain("tests/test_app.py");
    expect(data.outcomeLearning?.map((entry) => entry.path)).toContain("tests/test_app.py");
    expect(data.outcomeLearning?.[0].sources).toContain("outcome_history");
    expect(data.outcomeLearning?.[0].evidence?.join(" ")).toContain("outcome");
    expect(data.outcomeLearning?.[0].command).toBe(`cd ${repo} && pytest tests/test_app.py`);
  });

it("recommends scoped pytest consumers when conftest fixtures change", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(
      path.join(repo, "tests/conftest.py"),
      "import pytest\n\n@pytest.fixture\ndef client():\n    return 'root-client-v2'\n\n@pytest.fixture(autouse=True)\ndef reset_state():\n    return None\n",
      "utf8"
    );

    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    const tests = (plan.data as { tests: Array<{ path: string; evidenceTier: string; reason: string }> }).tests;
    expect(tests.some((test) => test.path === "tests/test_app.py" && test.evidenceTier === "authoritative" && test.reason.includes("tests/conftest.py"))).toBe(true);
    expect(tests.some((test) => test.path === "tests/api/test_conftest_scope.py" && test.evidenceTier === "heuristic" && test.reason.includes("pytest autouse fixture reset_state"))).toBe(true);
    expect(plan.text).toContain("pytest tests/test_app.py");
  });

it("compares exact raw search against Codexa-ranked context without overstating value", async () => {
    const repo = await createFixtureRepo();
    await writeFile(path.join(repo, "src/unique-marker.ts"), "export const marker = 'codexa_unique_fixture_literal'\n", "utf8");
    await writeFile(path.join(repo, "src/dash-marker.ts"), "export const dashMarker = '-codexa-dash-literal'\n", "utf8");
    await writeFile(path.join(repo, "src/pascal-search-marker.ts"), "export const CodexaPascalSearchMarker = 1\n", "utf8");
    await writeFile(path.join(repo, "src/snake-search-marker.ts"), "export const snake = 'codexa_snake_search_marker'\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add marker"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const result = await searchQuery(repo, { query: "codexa_unique_fixture_literal", limit: 5 }, { autoRefresh: false });
    expect(result.text).toContain("raw-sufficient");
    expect(result.text).toContain("src/unique-marker.ts");
    const resultData = result.data as { files: Array<{ path: string }>; actionability: string };
    expect(resultData.files[0].path).toBe("src/unique-marker.ts");
    expect(resultData.actionability).toBe("raw_search_sufficient");
    expect(result.text).toContain("Actionability: raw_search_sufficient");

    const dash = await searchQuery(repo, { query: "-codexa-dash-literal", limit: 5 }, { autoRefresh: false });
    expect(dash.text).toContain("src/dash-marker.ts");

    const multi = await searchQuery(
      repo,
      { query: "variant marker search", patterns: ["CodexaPascalSearchMarker", "codexa_snake_search_marker"], limit: 5 },
      { autoRefresh: false }
    );
    expect(multi.text).toContain("Search patterns:");
    expect(multi.text).toContain("Raw hits (multi-pattern):");
    expect(multi.text).toContain("Search discipline:");
    const multiData = multi.data as { patterns: string[]; files: Array<{ path: string }> };
    expect(multiData.patterns).toEqual(["variant marker search", "CodexaPascalSearchMarker", "codexa_snake_search_marker"]);
    expect(multiData.files.map((file) => file.path)).toEqual(expect.arrayContaining(["src/pascal-search-marker.ts", "src/snake-search-marker.ts"]));

    await expect(
      searchQuery(
        repo,
        {
          query: "variant marker search",
          patterns: Array.from({ length: 8 }, (_, index) => `codexa-extra-pattern-${index}`),
          limit: 5
        },
        { autoRefresh: false }
      )
    ).rejects.toThrow("Raw search supports at most 8 literal patterns");
  });

it("downgrades empty search context instead of reporting false high quality", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const result = await searchQuery(repo, { query: "codexa_absent_qxjv_zzzz", limit: 5 }, { autoRefresh: false });
    expect(result.text).toContain("Context quality: low");
    expect(result.text).toContain("No indexed evidence was found");
    expect((result.data as { quality: { level: string }; files: unknown[] }).quality.level).toBe("low");
    expect((result.data as { quality: { level: string }; files: unknown[] }).files).toHaveLength(0);
  });

it("keeps non-heuristic mixed-language test evidence even when kind compatibility disagrees", async () => {
    const repo = await createFixtureRepo();
    await writeFile(
      path.join(repo, "web/src/integration.test.ts"),
      "import { describe, expect, it } from 'vitest'\ndescribe('python-backed integration', () => { it('covers it', () => expect(true).toBe(true)) })\n",
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-integration-test"], {
      cwd: repo,
      stdio: "ignore"
    });
    const index = await buildIndex({ repoRoot: repo });
    const indexPath = path.join(repo, ".codex/codebase/index.json");
    index.testEdges.push({
      id: "test-edge:mixed-language-integration",
      type: "TestEdge",
      path: "web/src/integration.test.ts",
      targetPath: "service/helpers.py",
      reason: "mixed-language integration coverage",
      source: "git",
      confidence: "authoritative",
      snapshotId: index.snapshot.snapshotId,
      indexedAt: index.snapshot.indexedAt
    });
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: false });
    expect(plan.text).toContain("web/src/integration.test.ts");
    expect(plan.text).toContain("authoritative;");
    expect(plan.text).toContain("covers service/helpers.py");
  });
});
