import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitState } from "../src/git.js";
import { buildIndex, buildIndexLocked, loadIndex } from "../src/indexer.js";
import { loadExternalRiskSignals } from "../src/risk-ingest.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
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
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  statusQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "../src/queries.js";

describe("Codexa indexer", () => {
  it("indexes TypeScript and Python symbols, imports, decorators, tests, and usage sites", async () => {
    const repo = await createFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    expect(index.files.map((file) => file.path)).toContain("src/api.ts");
    expect(index.files.map((file) => file.path)).toContain("service/app.py");
    expect(index.files.find((file) => file.path === "src/generated/client.ts")?.generated).toBe(true);
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "handleThing")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "ThingService.compute")).toBe(true);
    expect(index.symbols.filter((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_thing")).toHaveLength(1);
    expect(index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_thing")?.kind).toBe("route");
    expect(index.symbols.filter((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_async")).toHaveLength(1);
    expect(index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_async")?.kind).toBe("route");
    expect(index.usageSites.some((usage) => usage.path === "service/app.py" && usage.kind === "route_handler" && usage.name === "GET /api/concat")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/app.py" && usage.kind === "route_handler" && usage.name === "GET /api/multiline")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/app.py" && usage.kind === "endpoint_reference" && usage.name === "GET /api/multiline")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "web/src/api-constant.ts" && usage.kind === "endpoint_reference")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.qualifiedName === "npm script test" && symbol.source === "manifest")).toBe(true);
    expect(index.imports.some((imp) => imp.specifier === "./util" && imp.resolvedPath === "src/util.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/js-ext-import.ts" && imp.specifier === "./util.js" && imp.resolvedPath === "src/util.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/uses-constant.ts" && imp.specifier === "./constants.js" && imp.resolvedPath === "src/constants.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/uses-type-only.ts" && imp.specifier === "./types-only" && imp.resolvedPath === "src/types-only.ts" && imp.typeOnly)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "IMPORTS" && edge.fromPath === "src/uses-type-only.ts" && edge.toPath === "src/types-only.ts")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/uses-type-only.ts" && usage.name === "FooTypeOnly" && usage.kind !== "type_reference" && usage.targetSymbolId)).toBe(false);
    expect(index.imports.some((imp) => imp.path === "src/barrel.ts" && imp.specifier === "./util" && imp.reExport && imp.resolvedPath === "src/util.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/aliased.ts" && imp.importedName === "helper" && imp.localName === "renamedHelper")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/ns.ts" && imp.importedName === "*" && imp.localName === "util")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/dynamic-import.ts" && imp.specifier === "./lazy" && imp.resolvedPath === "src/lazy.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.specifier === "@/lib/thing" && imp.resolvedPath === "web/src/lib/thing.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.specifier === ".helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/submodule_user.py" && imp.specifier === "service" && imp.importedName === "helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/multiline.py" && imp.importedName === "normalize" && imp.localName === "normalize_multiline")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/package_user.py" && imp.specifier === "service" && imp.resolvedPath === "service/__init__.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/alias_app.py" && imp.importedName === "normalize" && imp.localName === "clean")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/ns_app.py" && imp.specifier === "service.helpers" && imp.localName === "helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingContract" && symbol.kind === "interface")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "BaseContract" && symbol.kind === "interface")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingWidget" && symbol.kind === "class")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "default" && symbol.exported)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "web/src/Wrapped.tsx" && symbol.name === "WrappedWidget" && symbol.exported)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingMode" && symbol.kind === "type")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingState" && symbol.kind === "enum")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.kind === "node" && symbol.name === "s2s.audio.speech_to_speech")).toBe(true);
    expect(index.usageSites.some((usage) => usage.name === "s2s.audio.speech_to_speech" && usage.targetSymbolId)).toBe(true);
    expect(index.usageSites.some((usage) => usage.name === "normalize" && usage.targetSymbolId)).toBe(true);
    const helperSymbol = index.symbols.find((symbol) => symbol.path === "src/util.ts" && symbol.name === "helper");
    expect(index.usageSites.find((usage) => usage.path === "src/unused-external.ts" && usage.name === "helper" && usage.kind === "import")?.targetSymbolId).toBeUndefined();
    const missingDefaultSymbol = index.symbols.find((symbol) => symbol.path === "src/named-default-missing.ts" && symbol.name === "MissingDefault");
    expect(index.usageSites.some((usage) => usage.path === "src/named-default-consumer.ts" && usage.targetSymbolId === missingDefaultSymbol?.id)).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/aliased.ts" && usage.name === "renamedHelper" && usage.targetSymbolId === helperSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/ns.ts" && usage.name === "util.helper" && usage.targetSymbolId === helperSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/js-ext-import.ts" && usage.name === "jsHelper" && usage.targetSymbolId === helperSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/barrel-consumer.ts" && usage.name === "helper" && usage.targetSymbolId === helperSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/chained-consumer.ts" && usage.name === "chainedHelper" && usage.targetSymbolId === helperSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/ambiguous-consumer.ts" && usage.name === "sharedHelper" && usage.targetSymbolId)).toBe(false);
    const valueSymbol = index.symbols.find((symbol) => symbol.path === "src/constants.ts" && symbol.name === "VALUE" && symbol.kind === "variable");
    expect(valueSymbol).toBeTruthy();
    expect(index.symbols.some((symbol) => symbol.path === "web/src/feature.ts" && symbol.name === "nodeType" && symbol.kind === "variable")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/uses-constant.ts" && usage.name === "LOCAL_VALUE" && usage.kind === "reference" && usage.targetSymbolId === valueSymbol?.id)).toBe(true);
    const defaultSymbol = index.symbols.find((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "default");
    expect(index.usageSites.some((usage) => usage.path === "src/default-consumer.ts" && usage.name === "DefaultThing" && usage.targetSymbolId === defaultSymbol?.id)).toBe(true);
    const normalizeSymbol = index.symbols.find((symbol) => symbol.path === "service/helpers.py" && symbol.name === "normalize");
    expect(index.usageSites.some((usage) => usage.path === "service/alias_app.py" && usage.name === "clean" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/ns_app.py" && usage.name === "helpers.normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/multiline.py" && usage.name === "normalize_multiline" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/package_user.py" && usage.name === "normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/submodule_user.py" && usage.name === "helpers.normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    const serviceStart = index.symbols.find((symbol) => symbol.path === "src/service-class.ts" && symbol.qualifiedName === "Service.start");
    expect(index.usageSites.some((usage) => usage.path === "src/service-class-consumer.ts" && usage.name === "mod.Service.start" && usage.targetSymbolId === serviceStart?.id)).toBe(true);
    const objectGet = index.symbols.find((symbol) => symbol.path === "src/object-client.ts" && symbol.name === "get");
    expect(index.usageSites.some((usage) => usage.path === "src/object-client-consumer.ts" && usage.name === "client.get" && usage.targetSymbolId === objectGet?.id)).toBe(false);
    const fixtureSymbol = index.symbols.find((symbol) => symbol.path === "tests/test_app.py" && symbol.name === "value" && symbol.kind === "fixture");
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "value" && usage.kind === "test_reference" && usage.targetSymbolId === fixtureSymbol?.id)).toBe(true);
    const dangerSymbol = index.symbols.find((symbol) => symbol.path === "web/src/Danger.tsx" && symbol.name === "Danger");
    expect(index.usageSites.some((usage) => usage.path === "web/src/uses-danger.tsx" && usage.name === "Danger" && usage.targetSymbolId === dangerSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.name.includes("router.get") && usage.confidence === "heuristic")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/feature.ts" && risk.signal === "react-hook")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "shell-execution-boundary")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "filesystem-write-boundary")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/Danger.tsx" && risk.signal === "dangerous-html-sink")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/Wrapped.tsx" && risk.signal === "react-component")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "scripts/service-control.sh" && risk.signal === "operator-runtime")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/app.py" && risk.signal === "semgrep.fastapi-auth" && risk.source === "static-analysis")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_app.py")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_alias_app.py" && edge.targetPath === "service/alias_app.py" && edge.reason === "imports service/alias_app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "CALLS" && edge.toSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "EXTENDS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "IMPLEMENTS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "TYPE_EXPORTS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ROUTE_HANDLES" && edge.fromPath === "service/app.py")).toBe(true);
    expect(index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.name === "on_startup")?.kind).not.toBe("route");
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "service/app.py")).toBe(false);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/api-client.ts" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/concat-api-client.ts" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/items-get-client.ts" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/items-post-client.ts" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/items-put-client.ts" && edge.toPath === "service/app.py")).toBe(false);
    const defaultGetRoute = index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.name === "route_default_get");
    const defaultPostRoute = index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.name === "route_default_post");
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/default-fetch-client.ts" && edge.toSymbolId === defaultGetRoute?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/default-fetch-client.ts" && edge.toSymbolId === defaultPostRoute?.id)).toBe(false);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/default-fetch-post-client.ts" && edge.toSymbolId === defaultPostRoute?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/default-fetch-post-client.ts" && edge.toSymbolId === defaultGetRoute?.id)).toBe(false);
    const queryRoute = index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.name === "route_query");
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/query-client.ts" && edge.toSymbolId === queryRoute?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/dynamic-api-client.ts" && edge.toPath === "service/collision.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "UI_CALLS_ENDPOINT" && edge.fromPath === "web/src/bad-api-client.ts" && edge.toPath === "service/collision.py")).toBe(false);
    const routeThingSymbol = index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_thing");
    const routeGlobalStoreSymbol = index.symbols.find((symbol) => symbol.path === "service/app.py" && symbol.qualifiedName === "route_global_store");
    expect(index.graphEdges.filter((edge) => edge.edgeKind === "ROUTE_CALLS_STORE" && edge.fromSymbolId === routeThingSymbol?.id && edge.toPath === "service/store.py")).toHaveLength(1);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ROUTE_CALLS_STORE" && edge.fromSymbolId === routeGlobalStoreSymbol?.id && edge.toPath === "service/store.py" && edge.reason.includes("(inferred)"))).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "STORE_DISPATCHES_ADAPTER" && edge.fromPath === "service/app.py")).toBe(false);
    const storeAdapterEdges = index.graphEdges.filter((edge) => edge.edgeKind === "STORE_DISPATCHES_ADAPTER" && edge.fromPath === "service/store.py" && edge.toPath === "service/adapters/s2s.py");
    expect(storeAdapterEdges).toHaveLength(1);
    expect(storeAdapterEdges[0].confidence).not.toBe("authoritative");
    expect(index.graphEdges.some((edge) => edge.edgeKind === "STORE_DISPATCHES_ADAPTER" && edge.fromPath === "service/models/app.py")).toBe(false);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "atlas_api/packages/atlas.s2s.json" && edge.toPath === "atlas_api/adapters/s2s.py")).toBe(true);
    const imageManifestEdges = index.graphEdges.filter((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "atlas_api/packages/atlas.image.json");
    expect(imageManifestEdges.map((edge) => edge.toPath)).toEqual(["atlas_api/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "TEST_COVERS_WORKFLOW" && edge.fromPath === "tests/test_app.py" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.workflows.some((workflow) => workflow.title.includes("route route_thing") && workflow.relatedFiles.includes("service/helpers.py"))).toBe(true);
    expect(index.workflows.some((workflow) => workflow.title.includes("route route_thing") && workflow.relatedFiles.includes("web/src/api-client.ts"))).toBe(true);
    expect(index.files.every((file) => Number.isFinite(file.rank))).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "sarif-shell")).toBe(true);
    expect(index.risks.some((risk) => risk.path.startsWith("..") || path.isAbsolute(risk.path))).toBe(false);
  });

  it("writes valid artifacts and reports dirty overlay freshness", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const readme = await readFile(path.join(repo, ".codex/codebase/README.md"), "utf8");
    const contract = await readFile(path.join(repo, ".codex/codebase/codex-contract.md"), "utf8");
    const facts = await readFile(path.join(repo, ".codex/codebase/facts.ndjson"), "utf8");
    expect(readme).toContain("Codexa Codebase Context");
    expect(contract).toContain("Codexa Codex Contract");
    expect(contract).toContain("change_plan");
    expect(contract).toContain("post_edit_review");
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

  it("writes and reuses a parse cache for unchanged files", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    const cachePath = path.join(repo, ".codex/cache/codexa-parse-cache.json");
    const firstCache = JSON.parse(await readFile(cachePath, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(firstCache.entries)).toContain("src/api.ts");

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

  it("compares exact raw search against Codexa-ranked context without overstating value", async () => {
    const repo = await createFixtureRepo();
    await writeFile(path.join(repo, "src/unique-marker.ts"), "export const marker = 'codexa_unique_fixture_literal'\n", "utf8");
    await writeFile(path.join(repo, "src/dash-marker.ts"), "export const dashMarker = '-codexa-dash-literal'\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add marker"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const result = await searchQuery(repo, { query: "codexa_unique_fixture_literal", limit: 5 }, { autoRefresh: false });
    expect(result.text).toContain("raw-sufficient");
    expect(result.text).toContain("src/unique-marker.ts");
    expect((result.data as { files: Array<{ path: string }> }).files[0].path).toBe("src/unique-marker.ts");

    const dash = await searchQuery(repo, { query: "-codexa-dash-literal", limit: 5 }, { autoRefresh: false });
    expect(dash.text).toContain("src/dash-marker.ts");
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

  it("separates evidence tiers and uses natural retrieval instead of broad-task fallback", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const manifestImpact = await impactQuery(repo, { file: "atlas_api/packages/atlas.s2s.json" }, { autoRefresh: false });
    expect(manifestImpact.text).toContain("Authoritative read first:");
    expect(manifestImpact.text).toContain("Heuristic expansion:");
    const impactData = manifestImpact.data as {
      selectedFiles: string[];
      affectedFiles: Array<{ file: { path: string } }>;
      evidenceTiers: { authoritative: Array<{ file: { path: string } }>; heuristic: Array<{ file: { path: string } }> };
      quality: { level: string };
      value: { value: string };
    };
    expect(impactData.evidenceTiers.authoritative.some((entry) => entry.file.path === "atlas_api/packages/atlas.s2s.json")).toBe(true);
    expect(impactData.evidenceTiers.heuristic.length).toBeGreaterThan(0);
    expect(impactData.selectedFiles.length).toBeLessThanOrEqual(impactData.affectedFiles.length);
    expect(impactData.value.value).not.toBe("high");

    const fallbackPack = await contextPackQuery(repo, { task: "Understand route workflow safely", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect(fallbackPack.text).toContain("natural task retrieval");
    expect(fallbackPack.text).toContain("workflow route");
    const packData = fallbackPack.data as { quality: { level: string }; focusFiles: Array<{ tier: string }>; value: { value: string } };
    expect(packData.quality.level).not.toBe("low");
    expect(packData.focusFiles.every((entry) => entry.tier === "fallback")).toBe(false);
    expect(packData.quality.level === "medium" ? packData.value.value : "medium").not.toBe("high");
  });

  it("builds a token-budgeted repo map with stable truncation", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const map = await repoMapQuery(repo, 20, { autoRefresh: false }, 400);
    expect(map.text).toContain("Budget: 400 tokens");
    expect(map.text).toContain("Read first:");
    expect(map.text.length).toBeLessThanOrEqual(400 * 4);
    expect((map.data as { quality: { level: string } }).quality.level).toMatch(/high|medium|low/);
  });

  it("uses symbol usages and changed diff ranges for impact and test planning", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const fileImpact = await impactQuery(repo, { file: "src/util.ts" }, { autoRefresh: false });
    expect(fileImpact.text).toContain("src/api.ts");
    expect(fileImpact.text).toContain("call helper");
    const symbolImpact = await impactQuery(repo, { symbol: "helper" }, { autoRefresh: false });
    expect(symbolImpact.text).toContain("src/aliased.ts");
    expect(symbolImpact.text).toContain("src/ns.ts");

    await writeFile(path.join(repo, "src/util.ts"), "export function helper() {\n  return 42\n}\n", "utf8");
    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    expect(plan.text).toContain("Changed symbols:");
    expect(plan.text).toContain("helper");

    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect(diff.text).toContain("Grouped impact:");
    expect(diff.text).toContain("src [source/typescript]");
  });

  it("builds file explanations with reverse edges and task briefs with bounded impact expansion", async () => {
    const repo = await createFixtureRepo();
    await writeFile(path.join(repo, "service/helpers_decoy.py"), "def normalize_decoy(value):\n    return value\n", "utf8");
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(repo, `src/unrelated_dirty_${index}.ts`), `export const unrelatedDirty${index} = ${index}\n`, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", "-c user.name=Codexa -c user.email=codexa@example.invalid commit -m add-broad-dirty-fixtures".split(" "), {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });
    const broadDirtyPaths = [
      "src/util.ts",
      "src/api.ts",
      "src/aliased.ts",
      "src/ns.ts",
      "src/js-ext-import.ts",
      "src/constants.ts",
      "src/uses-constant.ts",
      "src/ops.ts",
      "src/a/config.ts",
      "src/b/config.ts",
      "web/src/lib/thing.ts",
      "web/src/Danger.tsx"
    ];
    for (const [index, filePath] of broadDirtyPaths.entries()) {
      await writeFile(path.join(repo, filePath), `export const unrelatedDirtyMutation${index} = ${index + 100}\n`, "utf8");
    }

    const fileContext = await fileContextQuery(repo, "service/helpers.py", { autoRefresh: false });
    expect(fileContext.text).toContain("Imported by:");
    expect(fileContext.text).toContain("service/app.py");
    expect(fileContext.text).toContain("External usage sites:");
    expect(fileContext.text).toContain("Covered by tests:");
    expect((fileContext.data as { importedBy: unknown[]; externalUsages: unknown[]; testedBy: unknown[] }).importedBy.length).toBeGreaterThan(0);

    const pack = await contextPackQuery(
      repo,
      {
        task: "Change normalize behavior safely",
        files: ["service/helpers.py"],
        query: "normalize",
        diff: true,
        changeType: "api",
        tokenBudget: 1300,
        limit: 7
      },
      { autoRefresh: false }
    );
    const focusPaths = (pack.data as { focusFiles: Array<{ file: { path: string } }> }).focusFiles.map((entry) => entry.file.path);
    expect(focusPaths).toContain("service/helpers.py");
    expect(focusPaths).toContain("service/app.py");
    expect(focusPaths).toContain("tests/test_app.py");
    expect(focusPaths).not.toContain("service/helpers_decoy.py");
    expect(focusPaths.some((filePath) => broadDirtyPaths.includes(filePath))).toBe(false);
    expect(pack.text).toContain("broad dirty tree");

    const brief = await taskBriefQuery(
      repo,
      {
        task: "Change normalize behavior safely",
        files: ["service/helpers.py"],
        diff: false,
        changeType: "api",
        tokenBudget: 1300,
        limit: 7
      },
      { autoRefresh: false }
    );
    expect(brief.text).toContain("Codexa task brief");
    expect((brief.data as { mode: string }).mode).toBe("task_brief");
  });

  it("does not guess ambiguous file or symbol targets", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const symbolImpact = await impactQuery(repo, { symbol: "config" });
    expect(symbolImpact.text).toContain("Ambiguous symbol target");
    expect(symbolImpact.text).toContain("src/a/config.ts");
    expect(symbolImpact.text).toContain("src/b/config.ts");

    const fileImpact = await impactQuery(repo, { file: "config.ts" });
    expect(fileImpact.text).toContain("Ambiguous file target");

    const outside = await impactQuery(repo, { file: path.join(os.tmpdir(), "src/api.ts") });
    expect(outside.text).toContain("No file or symbol matched impact target");
    expect(outside.text).not.toContain("Impact target");
  });

  it("reports changed files that are not in the current index", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/new_helper.py"), "def later():\n    return 1\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: false });
    expect(plan.text).toContain("Changed but not indexed");
    expect(plan.text).toContain("service/new_helper.py");
  });

  it("reports rename diff kinds instead of losing the new path", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    execFileSync("git", ["mv", "src/util.ts", "src/util_moved.ts"], { cwd: repo, stdio: "ignore" });

    const status = await statusQuery(repo);
    expect(status.freshness.dirtyFiles).toContain("src/util_moved.ts");
    expect(status.freshness.dirtyFiles).not.toContain("src/util.ts");

    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect(diff.text).toContain("src/util_moved.ts");
    expect(diff.text).toContain("renamed");
    expect(diff.text).toContain("Changed but not indexed");
  });

  it("does not fabricate Python test commands without repo metadata provenance", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-no-test-metadata-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "service"));
    await mkdirp(path.join(repo, "tests"));
    await writeFile(path.join(repo, "service/mod.py"), "def work():\n    return 1\n", "utf8");
    await writeFile(path.join(repo, "tests/test_mod.py"), "from service.mod import work\n\ndef test_work():\n    assert work() == 1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });

    const impact = await impactQuery(repo, { file: "service/mod.py" }, { autoRefresh: false });
    expect(impact.text).toContain("tests/test_mod.py");
    expect(impact.text).not.toContain("Candidate test commands");
    expect(impact.text).not.toContain("pytest tests/test_mod.py");
  });

  it("auto-refreshes missing and stale indexes for context queries when requested", async () => {
    const repo = await createFixtureRepo();
    const missing = await impactQuery(repo, { file: "src/api.ts" }, { autoRefresh: true });
    expect(missing.text).toContain("auto-refreshed from missing-index");
    expect(missing.freshness.stale).toBe(false);

    await writeFile(path.join(repo, "src/late.ts"), "export function lateFeature() { return 4 }\n", "utf8");
    const context = await impactQuery(repo, { file: "src/late.ts" }, { autoRefresh: true });
    expect(context.text).toContain("auto-refreshed from dirty-files-changed");
    expect(context.text).toContain("src/late.ts");
    expect(context.freshness.stale).toBe(false);
  });

  it("builds a bounded task-shaped context pack", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");

    const pack = await contextPackQuery(
      repo,
      {
        task: "Change helper normalization safely",
        files: ["service/helpers.py"],
        query: "normalize",
        diff: true,
        tokenBudget: 900,
        limit: 6
      },
      { autoRefresh: true }
    );
    expect(pack.text).toContain("Codexa context pack");
    expect(pack.text).toContain("Read first:");
    expect(pack.text).toContain("Likely tests:");
    expect(pack.text).toContain("tests/test_app.py");
    expect(pack.text.length).toBeLessThanOrEqual(900 * 4 + 40);
  });

  it("answers broad focus, graph, workflow, dependency, and change-plan queries", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const focus = await focusBriefQuery(repo, { task: "How does route normalization workflow work?", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    expect(focus.text).toContain("Codexa focus brief");
    expect(focus.text).toContain("Recommended next MCP call: workflow_path");
    expect((focus.data as { focusFiles: Array<{ path: string }> }).focusFiles.map((file) => file.path)).toContain("service/app.py");
    expect((focus.data as { quality: { counts: { heuristic: number; derived: number } } }).quality.counts.heuristic).toBeGreaterThan(0);
    expect((focus.data as { quality: { counts: { heuristic: number; derived: number } } }).quality.counts.derived).toBe(0);

    const fallbackFocus = await focusBriefQuery(repo, { task: "narlple frondicate zindle", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.fallback).toBeGreaterThan(0);
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.derived).toBe(0);

    const exactFocus = await focusBriefQuery(repo, { task: "Fix src/api.ts handleThing", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((exactFocus.data as { focusFiles: Array<{ path: string }>; quality: { counts: { derived: number } } }).focusFiles.map((file) => file.path)).toContain("src/api.ts");
    expect((exactFocus.data as { quality: { counts: { derived: number } } }).quality.counts.derived).toBeGreaterThan(0);

    const pathAliasFocus = await focusBriefQuery(repo, { task: "Fix TypeScript path alias configuration", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((pathAliasFocus.data as { retrieval: { intents: string[] }; nextCall: { tool: string } }).retrieval.intents).not.toContain("workflow");
    expect((pathAliasFocus.data as { retrieval: { intents: string[] }; nextCall: { tool: string } }).nextCall.tool).not.toBe("workflow_path");

    const callers = await callersQuery(repo, { symbol: "normalize", limit: 20 }, { autoRefresh: false });
    expect(callers.text).toContain("Callers/importers");
    expect(callers.text).toContain("service/app.py");
    expect((callers.data as { edges: Array<{ edgeKind: string }> }).edges.some((edge) => edge.edgeKind === "CALLS" || edge.edgeKind === "REFERENCES")).toBe(true);

    const callees = await calleesQuery(repo, { symbol: "route_thing", limit: 20 }, { autoRefresh: false });
    expect(callees.text).toContain("Callees/dependencies");
    expect(callees.text).toContain("normalize");

    const dependency = await dependencyPathQuery(repo, { fromSymbol: "route_thing", toSymbol: "normalize", maxDepth: 4 }, { autoRefresh: false });
    expect(dependency.text).toContain("Dependency path");
    expect((dependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const importOnlyCallers = await callersQuery(repo, { symbol: "helper", limit: 40 }, { autoRefresh: false });
    expect(importOnlyCallers.text).toContain("src/import-only.ts");

    const importOnlyDependency = await dependencyPathQuery(repo, { fromSymbol: "helper", toFile: "src/import-only.ts", maxDepth: 4 }, { autoRefresh: false });
    expect((importOnlyDependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const endpointDependency = await dependencyPathQuery(repo, { fromFile: "web/src/query-client.ts", toSymbol: "route_query", maxDepth: 4 }, { autoRefresh: false });
    expect((endpointDependency.data as { path: unknown[] }).path.length).toBeGreaterThan(0);

    const workflow = await workflowPathQuery(repo, { query: "route normalization workflow", limit: 5 }, { autoRefresh: false });
    expect(workflow.text).toContain("route route_thing");
    expect(workflow.text).toContain("tests/test_app.py");
    expect(workflow.text).toContain("Core path files:");
    const workflowData = workflow.data as { files: string[]; relatedFiles: string[]; tests: string[] };
    expect(workflowData.files).toContain("service/app.py");
    expect(workflowData.files).toContain("service/store.py");
    expect(workflowData.files).not.toContain("tests/test_app.py");
    expect(workflowData.tests).toContain("tests/test_app.py");

    const specificWorkflow = await workflowPathQuery(repo, { query: "route_thing retries", limit: 5 }, { autoRefresh: false });
    expect(specificWorkflow.text).toContain("route route_thing");

    const routeWorkflow = await workflowPathQuery(repo, { symbol: "route_query", limit: 5 }, { autoRefresh: false });
    expect(routeWorkflow.text).toContain("route route_query");
    expect(routeWorkflow.text).not.toContain("route route_thing");

    const plan = await changePlanQuery(repo, { task: "Change route normalization safely", files: ["service/helpers.py"], diff: false, limit: 6 }, { autoRefresh: false });
    expect(plan.text).toContain("Codexa change plan");
    expect(plan.text).toContain("Read first:");
    expect(plan.text).toContain("tests/test_app.py");
  });

  it("saves task snapshots and reports post-edit drift against the actual dirty tree", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const plan = await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "fixture-normalize"
      },
      { autoRefresh: false }
    );
    expect(plan.text).toContain("Task snapshot: fixture-normalize");
    expect((plan.data as { snapshot?: { taskId: string; plannedEditTargets: string[] } }).snapshot?.plannedEditTargets).toContain("service/helpers.py");
    expect(await readFile(path.join(repo, ".codex/cache/codexa-tasks/fixture-normalize.json"), "utf8")).toContain("symbolBaseline");

    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().lower()\n", "utf8");
    await writeFile(
      path.join(repo, "src/ops.ts"),
      "import { execFileSync } from 'node:child_process'\nexport function risky() { execFileSync('echo', ['changed']) }\n",
      "utf8"
    );

    const review = await postEditReviewQuery(repo, { taskId: "fixture-normalize", ranTests: [] }, { autoRefresh: true });
    expect(review.text).toContain("Codexa post-edit review");
    expect(review.text).toContain("auto-refreshed from dirty-files-changed");
    expect(review.text).toContain("service/helpers.py");
    expect(review.text).toContain("src/ops.ts");
    expect(review.text).toContain("Changed files grouped by module:");
    expect(review.text).toContain("Planned edit targets:");
    expect(review.text).toContain("Symbol delta:");
    expect(review.text).toContain("Risk deltas:");
    expect(review.text).toContain("Affected tests/workflows:");
    expect(review.text).toContain("Unplanned edited files: src/ops.ts");
    expect(review.text).toContain("tests/test_app.py");
    expect(review.text).toContain("Tests still unaccounted for");
    const reviewData = review.data as {
      verdict: string;
      unplannedEditedFiles: string[];
      tests: Array<{ path: string }>;
      symbolDeltas: unknown[];
      riskDeltas: unknown[];
      changedGroups: unknown[];
      snapshotLoad: { missingReason?: string };
    };
    expect(reviewData.verdict).not.toBe("continue");
    expect(reviewData.unplannedEditedFiles).toContain("src/ops.ts");
    expect(reviewData.tests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.changedGroups.length).toBeGreaterThan(0);
    expect(reviewData.riskDeltas.length).toBeGreaterThan(0);
    expect(reviewData.snapshotLoad.missingReason).toBeUndefined();

    await writeFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "{not json", "utf8");
    const recovered = await postEditReviewQuery(repo, { ranTests: [] }, { autoRefresh: false });
    expect((recovered.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.recoveredLatest).toBe(true);
    expect((recovered.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.missingReason).toBeUndefined();

    await writeFile(
      path.join(repo, ".codex/cache/codexa-tasks/latest.json"),
      JSON.stringify({ schemaVersion: 1, taskId: "missing-task", path: "missing-task.json", createdAt: new Date().toISOString() }),
      "utf8"
    );
    const recoveredMissingTarget = await postEditReviewQuery(repo, { ranTests: [] }, { autoRefresh: false });
    expect((recoveredMissingTarget.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.recoveredLatest).toBe(true);
    expect((recoveredMissingTarget.data as { snapshotLoad: { recoveredLatest?: boolean; missingReason?: string } }).snapshotLoad.missingReason).toBeUndefined();
  });

  it("flags changed symbols outside a requested symbol-scoped plan", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change plannedFoo safely",
        symbols: ["plannedFoo"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "symbol-scope"
      },
      { autoRefresh: false }
    );

    await writeFile(
      path.join(repo, "src/symbol-drift.ts"),
      "export function plannedFoo() {\n  return 1\n}\n\nexport function unplannedBar() {\n  return 200\n}\n",
      "utf8"
    );

    const review = await postEditReviewQuery(repo, { taskId: "symbol-scope", ranTests: [] }, { autoRefresh: true });
    expect(review.text).toContain("Changed symbols outside requested target: unplannedBar");
    expect(review.text).toContain("changed symbol(s) outside requested symbol target");
    expect((review.data as { unplannedChangedSymbols: Array<{ symbol: { name: string } }> }).unplannedChangedSymbols.map((entry) => entry.symbol.name)).toContain("unplannedBar");
  });

  it("treats planned renames as drift evidence without marking them unplanned", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Rename util safely",
        files: ["src/util.ts"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "rename-scope"
      },
      { autoRefresh: false }
    );
    execFileSync("git", ["mv", "src/util.ts", "src/util_renamed.ts"], { cwd: repo, stdio: "ignore" });

    const review = await postEditReviewQuery(repo, { taskId: "rename-scope", ranTests: [] }, { autoRefresh: true });
    expect(review.text).toContain("Planned renames: src/util.ts -> src/util_renamed.ts");
    expect((review.data as { unplannedEditedFiles: string[]; plannedRenames: Array<{ path: string; oldPath?: string }> }).unplannedEditedFiles).not.toContain("src/util_renamed.ts");
    expect((review.data as { unplannedEditedFiles: string[]; plannedRenames: Array<{ path: string; oldPath?: string }> }).plannedRenames[0].oldPath).toBe("src/util.ts");
  });

  it("recovers from malformed cache, stale locks, backup bundles, relocated bundles, and nested control paths", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const cachePath = path.join(repo, ".codex/cache/codexa-parse-cache.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Record<string, { contentHash: string; sizeBytes: number; result: unknown }>;
    };
    cache.entries["src/api.ts"].result = {};
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
    await expect(buildIndex({ repoRoot: repo })).resolves.toBeTruthy();

    const lockDir = path.join(repo, ".codex/cache/codexa-index.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 999999999,
        token: "dead-owner",
        processStartTime: "dead",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        repoRoot: repo
      }),
      "utf8"
    );
    await expect(buildIndexLocked({ repoRoot: repo, writeArtifacts: true })).resolves.toBeTruthy();

    const codebaseDir = path.join(repo, ".codex/codebase");
    const backupDir = path.join(repo, ".codex/.codebase.backup-test");
    await rename(codebaseDir, backupDir);
    const recovered = await loadIndex(repo);
    expect(recovered?.files.some((file) => file.path === "src/api.ts")).toBe(true);

    await buildIndex({ repoRoot: repo });
    const corruptBackupDir = path.join(repo, ".codex/.codebase.backup-corrupt-live");
    await rename(codebaseDir, corruptBackupDir);
    await mkdir(codebaseDir, { recursive: true });
    await writeFile(path.join(codebaseDir, "index.json"), "{not json", "utf8");
    const recoveredFromCorruptLive = await loadIndex(repo);
    expect(recoveredFromCorruptLive?.files.some((file) => file.path === "src/api.ts")).toBe(true);
    expect(await readFile(path.join(codebaseDir, "index.json"), "utf8")).toContain("\"schemaVersion\"");

    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const copied = JSON.parse(await readFile(indexPath, "utf8"));
    copied.freshness.repoRoot = "/tmp/not-this-repo";
    await writeFile(indexPath, `${JSON.stringify(copied)}\n`, "utf8");
    const status = await statusQuery(repo);
    expect(status.freshness.stale).toBe(true);
    expect(status.freshness.reason).toBe("repo-root-changed");

    const monorepo = await mkdtemp(path.join(os.tmpdir(), "codexa-nested-control-"));
    execFileSync("git", ["init"], { cwd: monorepo, stdio: "ignore" });
    await mkdirp(path.join(monorepo, "sub/.codex/codebase"));
    await writeFile(path.join(monorepo, "sub/a.ts"), "export const a = 1\n", "utf8");
    execFileSync("git", ["add", "sub/a.ts"], { cwd: monorepo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: monorepo,
      stdio: "ignore"
    });
    await writeFile(path.join(monorepo, "sub/.codex/codebase/index.json"), "{}", "utf8");
    await writeFile(path.join(monorepo, "sub/b.ts"), "export const b = 2\n", "utf8");
    expect(getGitState(path.join(monorepo, "sub")).dirtyFiles).toEqual(["b.ts"]);
  });

  it("refuses to build a false fresh index outside git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexa-not-git-"));
    await expect(buildIndex({ repoRoot: dir })).rejects.toThrow(/requires a git repository/);
  });
});

async function createFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-fixture-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" }, dependencies: {} }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "src/a"));
  await mkdirp(path.join(repo, "src/b"));
  await mkdirp(path.join(repo, "src/generated"));
  await mkdirp(path.join(repo, "web"));
  await mkdirp(path.join(repo, "web/src/lib"));
  await mkdirp(path.join(repo, "atlas_api/packages"));
  await mkdirp(path.join(repo, "atlas_api/adapters"));
  await mkdirp(path.join(repo, ".codex/static-analysis"));
  await mkdirp(path.join(repo, "reports"));
  await mkdirp(path.join(repo, "service"));
  await mkdirp(path.join(repo, "service/adapters"));
  await mkdirp(path.join(repo, "service/models"));
  await mkdirp(path.join(repo, "scripts"));
  await mkdirp(path.join(repo, "tests"));
  await writeFile(path.join(repo, "src/util.ts"), "export function helper() { return 1 }\n", "utf8");
  await writeFile(
    path.join(repo, "src/contracts.ts"),
    "export interface BaseContract { id: string }\nexport interface ThingContract extends BaseContract { mode?: ThingMode }\nexport type ThingMode = 'a' | 'b'\nexport enum ThingState { Ready = 'ready' }\nexport class ThingWidget implements ThingContract { id = 'thing' }\nexport default function DefaultThing() { return new ThingWidget() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/api.ts"),
    "import { helper } from './util'\nexport function handleThing() { return helper() }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/unused-external.ts"), "import { helper } from 'external-pkg'\nexport const untouched = 1\n", "utf8");
  await writeFile(path.join(repo, "src/import-only.ts"), "import { helper } from './util'\nexport const importerReady = true\n", "utf8");
  await writeFile(path.join(repo, "src/default-consumer.ts"), "import DefaultThing from './contracts'\nexport function makeDefault() { return DefaultThing() }\n", "utf8");
  await writeFile(path.join(repo, "src/named-default-missing.ts"), "export function MissingDefault() { return 1 }\n", "utf8");
  await writeFile(path.join(repo, "src/named-default-consumer.ts"), "import MissingDefault from './named-default-missing'\nexport function callMissingDefault() { return MissingDefault() }\n", "utf8");
  await writeFile(path.join(repo, "src/types-only.ts"), "export interface FooTypeOnly { id: string }\n", "utf8");
  await writeFile(path.join(repo, "src/uses-type-only.ts"), "import type { FooTypeOnly } from './types-only'\nexport type WrappedFoo = FooTypeOnly & { ready: boolean }\nexport function invalidRuntimeReference() { return FooTypeOnly }\n", "utf8");
  await writeFile(path.join(repo, "src/symbol-drift.ts"), "export function plannedFoo() {\n  return 1\n}\n\nexport function unplannedBar() {\n  return 2\n}\n", "utf8");
  await writeFile(path.join(repo, "src/barrel.ts"), "export { helper } from './util'\n", "utf8");
  await writeFile(path.join(repo, "src/barrel-consumer.ts"), "import { helper } from './barrel'\nexport function useBarrelHelper() { return helper() }\n", "utf8");
  await writeFile(path.join(repo, "src/chained-a.ts"), "export { helper } from './util'\n", "utf8");
  await writeFile(path.join(repo, "src/chained-b.ts"), "export { helper } from './chained-a'\n", "utf8");
  await writeFile(path.join(repo, "src/chained-consumer.ts"), "import { helper as chainedHelper } from './chained-b'\nexport function useChained() { return chainedHelper() }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-a.ts"), "export function sharedHelper() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-b.ts"), "export function sharedHelper() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-barrel.ts"), "export * from './ambiguous-a'\nexport * from './ambiguous-b'\n", "utf8");
  await writeFile(path.join(repo, "src/ambiguous-consumer.ts"), "import { sharedHelper } from './ambiguous-barrel'\nexport function useShared() { return sharedHelper() }\n", "utf8");
  await writeFile(
    path.join(repo, "src/aliased.ts"),
    "import { helper as renamedHelper } from './util'\nexport function handleAliasThing() { return renamedHelper() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/ns.ts"),
    "import * as util from './util'\nexport function handleNamespaceThing() { return util.helper() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/js-ext-import.ts"),
    "import { helper as jsHelper } from './util.js'\nexport function handleJsExtThing() { return jsHelper() }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/constants.ts"), "export const VALUE = 1\n", "utf8");
  await writeFile(
    path.join(repo, "src/uses-constant.ts"),
    "import { VALUE as LOCAL_VALUE } from './constants.js'\nexport const ANSWER = LOCAL_VALUE\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "src/ops.ts"),
    "import { execFileSync } from 'node:child_process'\nimport { writeFile } from 'node:fs/promises'\nexport async function rewriteFile(path: string) { execFileSync('echo', ['ok']); await writeFile(path, 'ok') }\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/a/config.ts"), "export function config() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "src/b/config.ts"), "export function config() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "src/generated/client.ts"), "export function generatedClient() { return 'generated' }\n", "utf8");
  await writeFile(path.join(repo, "src/lazy.ts"), "export function lazyValue() { return 'lazy' }\n", "utf8");
  await writeFile(path.join(repo, "src/dynamic-import.ts"), "export async function loadLazy() { return import('./lazy') }\n", "utf8");
  await writeFile(path.join(repo, "src/service-class.ts"), "export class Service { start() { return 1 } }\nexport class Other { start() { return 2 } }\n", "utf8");
  await writeFile(path.join(repo, "src/service-class-consumer.ts"), "import * as mod from './service-class'\nexport function runService() { return mod.Service.start() }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client.ts"), "export const client = { get() { return 1 } }\nexport function get() { return 2 }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client-consumer.ts"), "import { client } from './object-client'\nexport function runClient() { return client.get() }\n", "utf8");
  await writeFile(
    path.join(repo, "web/tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "web/src/lib/thing.ts"), "export function thing() { return 'thing' }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Danger.tsx"), "export function Danger({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/uses-danger.tsx"), "import { Danger } from './Danger'\nexport function UsesDanger() { return <Danger html=\"ok\" /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Wrapped.tsx"), "import { memo } from 'react'\nfunction Inner() { return <span /> }\nexport default memo(function WrappedWidget() { return <Inner /> })\n", "utf8");
  await writeFile(
    path.join(repo, "web/src/feature.ts"),
    "import { thing } from '@/lib/thing'\nexport const nodeType = 's2s.audio.speech_to_speech'\nexport function useFeatureThing() { return thing() }\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/api-client.ts"),
    "export async function loadThing() {\n  return fetch('/api/thing', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/dynamic-api-client.ts"),
    "export async function loadDynamicThing(thingId: string) {\n  return fetch(`/api/things/${thingId}`, { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/bad-api-client.ts"),
    "export async function loadStaticThing() {\n  return fetch('/api/things/static', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "web/src/concat-api-client.ts"),
    "export async function loadConcatThing() {\n  return fetch('/api/concat', { method: 'GET' })\n}\n",
    "utf8"
  );
  await writeFile(path.join(repo, "web/src/items-get-client.ts"), "export function getItems() { return fetch('/api/items', { method: 'GET' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/items-post-client.ts"), "export function postItems() { return fetch('/api/items', { method: 'POST' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/items-put-client.ts"), "export function putItems() { return fetch('/api/items', { method: 'PUT' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/default-fetch-client.ts"), "export function defaultFetch() { return fetch('/api/default-fetch') }\n", "utf8");
  await writeFile(path.join(repo, "web/src/default-fetch-post-client.ts"), "function makeHeaders() { return {} }\nexport function defaultFetchPost() {\n  return fetch(\n    '/api/default-fetch',\n    {\n      headers: makeHeaders(),\n      method: 'POST'\n    }\n  )\n}\n", "utf8");
  await writeFile(path.join(repo, "web/src/query-client.ts"), "export function loadQuery() { return fetch('/api/query?limit=25') }\n", "utf8");
  await writeFile(path.join(repo, "web/src/api-constant.ts"), "export const sampleEndpoint = '/api/not-a-route'\n", "utf8");
  await writeFile(
    path.join(repo, "atlas_api/packages/atlas.s2s.json"),
    JSON.stringify({ nodes: [{ type_id: "s2s.audio.speech_to_speech", title: "Speech to Speech", adapter_key: "s2s.speech_to_speech" }] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(repo, "atlas_api/packages/atlas.image.json"),
    JSON.stringify({ nodes: [{ type_id: "image.generate", title: "Image Generate", adapter_key: "image.generate" }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "atlas_api/adapters/s2s.py"), "class S2SAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "atlas_api/adapters/image_generate.py"), "class ImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "atlas_api/adapters/image.py"), "class ImageAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "atlas_api/adapters/generate.py"), "class GenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip()\n", "utf8");
  await writeFile(path.join(repo, "service/adapters/s2s.py"), "def dispatch(value):\n    return value\n", "utf8");
  await writeFile(path.join(repo, "service/store.py"), "from .adapters.s2s import dispatch\n\nclass AtlasStore:\n    def normalize_value(self, value):\n        return dispatch(value)\n", "utf8");
  await writeFile(path.join(repo, "service/__init__.py"), "from .helpers import normalize\n", "utf8");
  await writeFile(
    path.join(repo, "service/app.py"),
    "from .helpers import normalize\nfrom .store import AtlasStore\n\nstore = AtlasStore()\n\n@router.get('/api/thing')\ndef route_thing(value):\n    store = AtlasStore()\n    return store.normalize_value(normalize(value))\n\n@router.get('/api/global-store')\ndef route_global_store(value):\n    return store.normalize_value(normalize(value))\n\n@router.get('/api' + '/concat')\ndef route_concat(value):\n    return normalize(value)\n\n@router.api_route('/api/items', methods=['GET', 'POST'])\ndef route_items(value):\n    return normalize(value)\n\n@router.get(\n    '/api/multiline'\n)\ndef route_multiline_endpoint(value):\n    return normalize(value)\n\n@router.get('/api/default-fetch')\ndef route_default_get(value):\n    return normalize(value)\n\n@router.post('/api/default-fetch')\ndef route_default_post(value):\n    return normalize(value)\n\n@router.get('/api/query')\ndef route_query(value):\n    return normalize(value)\n\n@app.on_event('startup')\ndef on_startup():\n    return None\n\n@router.post('/async')\nasync def route_async(value):\n    return normalize(value)\n\nclass ThingService:\n    def compute(self, value):\n        return normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/models/app.py"),
    "from service.adapters.s2s import dispatch\n\n@router.get('/api/model-route')\ndef route_model(value):\n    return dispatch(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/collision.py"),
    "@router.get('/api/things/{thing_id}')\ndef route_dynamic_thing(thing_id):\n    return thing_id\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/alias_app.py"),
    "from .helpers import normalize as clean\n\ndef route_alias(value):\n    return clean(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/ns_app.py"),
    "import service.helpers as helpers\n\ndef route_ns(value):\n    return helpers.normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/multiline.py"),
    "from .helpers import (\n    normalize as normalize_multiline,\n)\n\ndef route_multiline(value):\n    return normalize_multiline(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/package_user.py"),
    "from service import normalize\n\ndef route_package(value):\n    return normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/submodule_user.py"),
    "from service import helpers\n\ndef route_submodule(value):\n    return helpers.normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_app.py"),
    "from service.app import route_thing\nimport pytest\n\n@pytest.fixture\ndef value():\n    return 'A'\n\ndef test_route(value):\n    assert route_thing(value) == 'A'\n\ndef test_route_client(client):\n    client.get('/api/thing')\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_alias_app.py"),
    "from service.alias_app import route_alias\n\ndef test_route_alias():\n    assert route_alias(' A ') == 'A'\n",
    "utf8"
  );
  await writeFile(path.join(repo, "scripts/service-control.sh"), "#!/usr/bin/env bash\nexec echo service\n", "utf8");
  await writeFile(
    path.join(repo, ".codex/static-analysis/semgrep.json"),
    JSON.stringify({ results: [{ check_id: "semgrep.fastapi-auth", path: "service/app.py", start: { line: 3 }, extra: { severity: "WARNING", message: "route should verify auth" } }] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(repo, "reports/semgrep.json"),
    JSON.stringify(
      {
        runs: [
          {
            results: [
              {
                ruleId: "sarif-shell",
                message: { text: "shell execution needs review" },
                locations: [{ physicalLocation: { artifactLocation: { uri: path.join(repo, "src/../src/ops.ts") }, region: { startLine: 3 } } }]
              },
              {
                ruleId: "sarif-outside",
                message: { text: "outside repo should be ignored" },
                locations: [{ physicalLocation: { artifactLocation: { uri: "/tmp/outside-codexa-risk.py" }, region: { startLine: 1 } } }]
              }
            ]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
