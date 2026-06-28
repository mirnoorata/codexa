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
it("ranks transitive import hubs above leaf consumers when the experiment flag is set", async () => {
    const repo = await createFixtureRepo();
    process.env.CODEXA_EXPERIMENTAL_TRANSITIVE_RANK = "1";
    try {
      const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
      const util = index.files.find((file) => file.path === "src/util.ts");
      const consumer = index.files.find((file) => file.path === "src/barrel-consumer.ts");
      expect(util?.rankReasons.transitiveCentrality).toBeGreaterThan(0);
      expect(util?.rankReasons.transitiveCentrality).toBeGreaterThan(consumer?.rankReasons.transitiveCentrality ?? 0);
      for (const file of index.files) {
        expect(file.rankReasons.transitiveCentrality).toBeGreaterThanOrEqual(0);
        expect(file.rankReasons.transitiveCentrality).toBeLessThanOrEqual(2);
      }
    } finally {
      delete process.env.CODEXA_EXPERIMENTAL_TRANSITIVE_RANK;
    }
  });

it("keeps default ranking free of transitive centrality without the experiment flag", async () => {
    const repo = await createFixtureRepo();
    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    for (const file of index.files) {
      expect(file.rankReasons.transitiveCentrality).toBe(0);
    }
  });

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
    expect(index.imports.some((imp) => imp.path === "src/barrel-consumer.ts" && imp.specifier === "./barrel" && imp.resolvedPath === "src/barrel.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/default-barrel.ts" && imp.specifier === "./contracts" && imp.importedName === "default" && imp.localName === "ContractDefault" && imp.reExport)).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/default-barrel.ts" && imp.specifier === "./contracts" && imp.importedName === "ThingContract" && imp.localName === "PublicThingContract" && imp.reExport && imp.typeOnly)).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/aliased.ts" && imp.importedName === "helper" && imp.localName === "renamedHelper")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/ns.ts" && imp.importedName === "*" && imp.localName === "util")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/dynamic-import.ts" && imp.specifier === "./lazy" && imp.resolvedPath === "src/lazy.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.specifier === "@/lib/thing" && imp.resolvedPath === "web/src/lib/thing.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "apps/a/src/use.ts" && imp.specifier === "@/lib" && imp.resolvedPath === "apps/a/src/lib.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "apps/b/src/use.ts" && imp.specifier === "@/lib" && imp.resolvedPath === "apps/b/src/lib.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "src/package-consumer.ts" && imp.specifier === "fixture-pkg/feature" && imp.resolvedPath === "src/package-entry.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.specifier === ".helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/submodule_user.py" && imp.specifier === "service" && imp.importedName === "helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/multiline.py" && imp.importedName === "normalize" && imp.localName === "normalize_multiline")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/package_user.py" && imp.specifier === "service" && imp.resolvedPath === "service/__init__.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/alias_app.py" && imp.importedName === "normalize" && imp.localName === "clean")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/ns_app.py" && imp.specifier === "service.helpers" && imp.localName === "helpers" && imp.resolvedPath === "service/helpers.py")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/src_layout_user.py" && imp.specifier === "acme.service" && imp.resolvedPath === "src/acme/service.py" && imp.confidence === "derived")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/plugin_user.py" && imp.specifier === "plugins.tasks" && imp.resolvedPath === "plugins/tasks.py" && imp.confidence === "derived")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/star_user.py" && imp.specifier === "service.deep" && imp.importedName === "clean_value" && imp.localName === "clean_value")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "service/deep/__init__.py" && imp.importedName === "Real" && imp.localName === "Public" && imp.reExport && imp.resolvedPath === "service/deep/internal.py")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingContract" && symbol.kind === "interface")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "BaseContract" && symbol.kind === "interface")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingWidget" && symbol.kind === "class")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "default" && symbol.exported)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "web/src/Wrapped.tsx" && symbol.name === "WrappedWidget" && symbol.exported)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingMode" && symbol.kind === "type")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/contracts.ts" && symbol.name === "ThingState" && symbol.kind === "enum")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.kind === "node" && symbol.name === "media.audio.transform")).toBe(true);
    expect(index.usageSites.some((usage) => usage.name === "media.audio.transform" && usage.targetSymbolId)).toBe(true);
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
    expect(index.usageSites.some((usage) => usage.path === "src/default-barrel-consumer.ts" && usage.name === "ContractDefault" && usage.targetSymbolId === defaultSymbol?.id)).toBe(true);
    const localDefaultSymbol = index.symbols.find((symbol) => symbol.path === "src/local-default.ts" && symbol.name === "default");
    expect(localDefaultSymbol?.source).toBe("typescript-compiler");
    expect(index.usageSites.some((usage) => usage.path === "src/local-default-consumer.ts" && usage.name === "LocalDefault" && usage.targetSymbolId === localDefaultSymbol?.id)).toBe(true);
    const normalizeSymbol = index.symbols.find((symbol) => symbol.path === "service/helpers.py" && symbol.name === "normalize");
    expect(index.usageSites.some((usage) => usage.path === "service/alias_app.py" && usage.name === "clean" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/ns_app.py" && usage.name === "helpers.normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/multiline.py" && usage.name === "normalize_multiline" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/package_user.py" && usage.name === "normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/submodule_user.py" && usage.name === "helpers.normalize" && usage.targetSymbolId === normalizeSymbol?.id)).toBe(true);
    const cleanSymbol = index.symbols.find((symbol) => symbol.path === "service/deep/utils.py" && symbol.name === "clean");
    expect(index.usageSites.some((usage) => usage.path === "service/deep/__init__.py" && usage.name === "clean_value" && usage.text.includes("__all__") && usage.targetSymbolId === cleanSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/deep_user.py" && usage.name === "clean_value" && usage.targetSymbolId === cleanSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/star_user.py" && usage.name === "clean_value" && usage.targetSymbolId === cleanSymbol?.id)).toBe(true);
    const realSymbol = index.symbols.find((symbol) => symbol.path === "service/deep/internal.py" && symbol.name === "Real");
    expect(index.usageSites.some((usage) => usage.path === "service/deep/__init__.py" && usage.name === "Public" && usage.text.includes("__all__") && usage.targetSymbolId === realSymbol?.id)).toBe(true);
    expect(realSymbol?.exported).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/reexport_user.py" && usage.name === "Public" && usage.targetSymbolId === realSymbol?.id)).toBe(true);
    const srcThingSymbol = index.symbols.find((symbol) => symbol.path === "src/acme/service.py" && symbol.name === "src_thing");
    expect(index.usageSites.some((usage) => usage.path === "service/src_layout_user.py" && usage.name === "src_thing" && usage.targetSymbolId === srcThingSymbol?.id)).toBe(true);
    const pluginRunSymbol = index.symbols.find((symbol) => symbol.path === "plugins/tasks.py" && symbol.name === "run_plugin");
    expect(index.usageSites.some((usage) => usage.path === "service/plugin_user.py" && usage.name === "plugin_tasks.run_plugin" && usage.targetSymbolId === pluginRunSymbol?.id)).toBe(true);
    const serviceStart = index.symbols.find((symbol) => symbol.path === "src/service-class.ts" && symbol.qualifiedName === "Service.start");
    expect(index.usageSites.some((usage) => usage.path === "src/service-class-consumer.ts" && usage.name === "mod.Service.start" && usage.targetSymbolId === serviceStart?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/instance-service-consumer.ts" && usage.name === "service.start" && usage.targetSymbolId === serviceStart?.id)).toBe(true);
    const objectGet = index.symbols.find((symbol) => symbol.path === "src/object-client.ts" && symbol.qualifiedName === "client.get");
    expect(index.usageSites.some((usage) => usage.path === "src/object-client-consumer.ts" && usage.name === "client.get" && usage.targetSymbolId === objectGet?.id)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/object-client.ts" && symbol.qualifiedName === "client.get" && symbol.kind === "method")).toBe(true);
    const fixtureSymbol = index.symbols.find((symbol) => symbol.path === "tests/test_app.py" && symbol.name === "value" && symbol.kind === "fixture");
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "value" && usage.kind === "test_reference" && usage.targetSymbolId === fixtureSymbol?.id)).toBe(true);
    const derivedFixtureSymbol = index.symbols.find((symbol) => symbol.path === "tests/test_app.py" && symbol.name === "derived" && symbol.kind === "fixture");
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "value" && usage.kind === "test_reference" && usage.usedBySymbolId === derivedFixtureSymbol?.id && usage.targetSymbolId === fixtureSymbol?.id)).toBe(true);
    const rootClientFixture = index.symbols.find((symbol) => symbol.path === "tests/conftest.py" && symbol.name === "client" && symbol.kind === "fixture");
    const apiClientFixture = index.symbols.find((symbol) => symbol.path === "tests/api/conftest.py" && symbol.name === "client" && symbol.kind === "fixture");
    const unitClientFixture = index.symbols.find((symbol) => symbol.path === "tests/unit/conftest.py" && symbol.name === "client" && symbol.kind === "fixture");
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "client" && usage.kind === "test_reference" && usage.targetSymbolId === rootClientFixture?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "tests/api/test_conftest_scope.py" && usage.name === "client" && usage.kind === "test_reference" && usage.targetSymbolId === apiClientFixture?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "tests/unit/test_conftest_scope.py" && usage.name === "client" && usage.kind === "test_reference" && usage.targetSymbolId === unitClientFixture?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "TestClient" && usage.kind === "test_reference")).toBe(false);
    const dangerSymbol = index.symbols.find((symbol) => symbol.path === "web/src/Danger.tsx" && symbol.name === "Danger");
    expect(index.usageSites.some((usage) => usage.path === "web/src/uses-danger.tsx" && usage.name === "Danger" && usage.targetSymbolId === dangerSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.name.includes("router.get") && usage.confidence === "heuristic")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/feature.ts" && risk.signal === "react-hook")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "shell-execution-boundary")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "filesystem-write-boundary")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/Danger.tsx" && risk.signal === "dangerous-html-sink")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/src/Wrapped.tsx" && risk.signal === "react-component")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "web/src/create-element.tsx" && usage.name === "Danger" && usage.targetSymbolId === dangerSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "web/src/uses-default-danger.tsx" && usage.name === "DangerDefault" && usage.targetSymbolId === dangerSymbol?.id)).toBe(true);
    expect(index.risks.some((risk) => risk.path === "scripts/service-control.sh" && risk.signal === "operator-runtime")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/app.py" && risk.signal === "semgrep.fastapi-auth" && risk.source === "static-analysis")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/frameworks.py" && risk.signal === "fastapi-route")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/frameworks.py" && risk.signal === "celery-task")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/frameworks.py" && risk.signal === "pydantic-model")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/frameworks.py" && risk.signal === "sqlalchemy-model")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/frameworks.py" && usage.name === "SchemaBase" && usage.kind === "type_reference")).toBe(true);
    const getDbSymbol = index.symbols.find((symbol) => symbol.path === "service/frameworks.py" && symbol.name === "get_db");
    const requireUserSymbol = index.symbols.find((symbol) => symbol.path === "service/frameworks.py" && symbol.name === "require_user");
    const rebuildNamedJobSymbol = index.symbols.find((symbol) => symbol.path === "service/frameworks.py" && symbol.name === "rebuild_named_job");
    expect(index.usageSites.some((usage) => usage.path === "service/frameworks.py" && usage.name === "get_db" && usage.text.includes("FastAPI Depends") && usage.confidence === "heuristic" && usage.targetSymbolId === getDbSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/frameworks.py" && usage.name === "require_user" && usage.text.includes("FastAPI Depends") && usage.confidence === "heuristic" && usage.targetSymbolId === requireUserSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/frameworks.py" && usage.name === "jobs.rebuild" && usage.text.includes("send_task") && usage.confidence === "heuristic" && usage.targetSymbolId === rebuildNamedJobSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/frameworks.py" && usage.name === "rebuild_named_job" && usage.text.includes("Celery task call") && usage.confidence === "derived" && usage.targetSymbolId === rebuildNamedJobSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/framework_sender.py" && usage.name === "get_db" && usage.text.includes("FastAPI Depends") && usage.confidence === "heuristic" && usage.targetSymbolId === getDbSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/framework_sender.py" && usage.name === "jobs.rebuild" && usage.text.includes("send_task") && usage.confidence === "heuristic" && usage.targetSymbolId === rebuildNamedJobSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "service/framework_sender.py" && usage.name === "rebuild_alias" && usage.text.includes("Celery task call") && usage.confidence === "heuristic" && usage.targetSymbolId === rebuildNamedJobSymbol?.id)).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "service/frameworks.py" && symbol.qualifiedName === "Item.title" && symbol.kind === "variable")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "service/frameworks.py" && symbol.qualifiedName === "User.email" && symbol.kind === "variable")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/frameworks.py" && risk.signal === "python-model-field" && risk.reason.includes("User.email"))).toBe(true);
    expect(index.risks.some((risk) => risk.path === "service/not_fastapi.py" && risk.signal === "fastapi-dependency")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_pydantic_model.py" && risk.signal === "pydantic-model")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_pydantic_model.py" && risk.signal === "python-model-field")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_sqlalchemy.py" && risk.signal === "sqlalchemy-model")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_sqlalchemy.py" && risk.signal === "python-model-field")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_sqlalchemy_import.py" && risk.signal === "sqlalchemy-model")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "service/not_sqlalchemy_import.py" && risk.signal === "python-model-field")).toBe(false);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_app.py")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_app.py" && edge.targetPath === "tests/conftest.py" && edge.reason.includes("pytest fixture client") && edge.confidence === "authoritative")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/api/test_conftest_scope.py" && edge.targetPath === "tests/api/conftest.py" && edge.reason.includes("pytest fixture client") && edge.confidence === "authoritative")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/api/test_conftest_scope.py" && edge.targetPath === "tests/conftest.py" && edge.reason.includes("pytest autouse fixture reset_state") && edge.confidence === "heuristic")).toBe(true);
    const scopedClientFixture = index.symbols.find((symbol) => symbol.path === "tests/test_app.py" && symbol.qualifiedName === "TestFixtureScope.scoped_client" && symbol.kind === "fixture");
    const outsideClassScopeTest = index.symbols.find((symbol) => symbol.path === "tests/test_app.py" && symbol.qualifiedName === "test_outside_class_scope" && symbol.kind === "test");
    expect(outsideClassScopeTest?.id).toBeTruthy();
    expect(index.usageSites.some((usage) => usage.path === "tests/test_app.py" && usage.name === "scoped_client" && usage.kind === "test_reference" && usage.targetSymbolId === scopedClientFixture?.id)).toBe(true);
    expect(
      index.usageSites.some(
        (usage) => usage.path === "tests/test_app.py" && usage.name === "scoped_client" && usage.kind === "test_reference" && usage.usedBySymbolId === outsideClassScopeTest!.id && usage.targetSymbolId
      )
    ).toBe(false);
    expect(index.testEdges.some((edge) => edge.path === "tests/test_alias_app.py" && edge.targetPath === "service/alias_app.py" && edge.reason === "imports service/alias_app.py")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "CALLS" && edge.toSymbolId === normalizeSymbol?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "EXTENDS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "IMPLEMENTS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "TYPE_EXPORTS" && edge.fromPath === "src/contracts.ts")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "web/tsconfig.json" && usage.name === "../src" && usage.text === "project reference ../src")).toBe(true);
    expect(index.risks.some((risk) => risk.path === "web/tsconfig.json" && risk.signal === "typescript-project-reference")).toBe(true);
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
    const storeAdapterEdges = index.graphEdges.filter((edge) => edge.edgeKind === "STORE_DISPATCHES_ADAPTER" && edge.fromPath === "service/store.py" && edge.toPath === "service/adapters/media.py");
    expect(storeAdapterEdges).toHaveLength(1);
    expect(storeAdapterEdges[0].confidence).not.toBe("authoritative");
    expect(index.graphEdges.some((edge) => edge.edgeKind === "STORE_DISPATCHES_ADAPTER" && edge.fromPath === "service/models/app.py")).toBe(false);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "sample_api/packages/project.media.json" && edge.toPath === "sample_api/adapters/media.py")).toBe(true);
    const imageManifestEdges = index.graphEdges.filter((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "sample_api/packages/project.image.json");
    expect(imageManifestEdges.map((edge) => edge.toPath)).toEqual(["sample_api/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "TEST_COVERS_WORKFLOW" && edge.fromPath === "tests/test_app.py" && edge.toPath === "service/app.py")).toBe(true);
    expect(index.workflows.some((workflow) => workflow.title.includes("route route_thing") && workflow.relatedFiles.includes("service/helpers.py"))).toBe(true);
    expect(index.workflows.some((workflow) => workflow.title.includes("route route_thing") && workflow.relatedFiles.includes("web/src/api-client.ts"))).toBe(true);
    const routeThingWorkflow = index.workflows.find((workflow) => workflow.title.includes("route route_thing"));
    expect(routeThingWorkflow?.processKind).toBe("cross-module-process");
    expect(routeThingWorkflow?.entryScore).toBeGreaterThan(0);
    expect(routeThingWorkflow?.terminalFiles).toEqual(expect.arrayContaining(["service/adapters/media.py", "service/helpers.py"]));
    expect(routeThingWorkflow?.relatedModules).toEqual(expect.arrayContaining(["service", "web/src"]));
    expect(routeThingWorkflow?.stepCounts?.entry).toBe(1);
    const serviceModule = index.modules.find((module) => module.name === "service");
    expect(serviceModule?.clusterKind).toBe("path");
    expect(serviceModule?.summary).toContain("Top symbols:");
    expect(serviceModule?.topSymbols).toEqual(expect.arrayContaining(["route_thing"]));
    expect(serviceModule?.workflows?.some((workflow) => workflow.includes("route route_thing"))).toBe(true);
    expect(serviceModule?.relationCount ?? 0).toBeGreaterThan(0);
    expect(serviceModule?.crossModuleRelationCount ?? 0).toBeGreaterThan(0);
    expect(serviceModule?.sourceModules).toEqual(expect.arrayContaining(["service"]));
    expect(serviceModule?.evidenceProfile?.symbolSources).toBeTruthy();
    expect(serviceModule?.summarySource).toBe("deterministic");
    expect(serviceModule?.summaryPrompt).toContain("using only cited files");
    const functionalModule = index.modules.find((module) => module.clusterKind === "functional" && module.workflows?.some((workflow) => workflow.includes("route route_thing")));
    expect(functionalModule?.files).toEqual(expect.arrayContaining(["service/app.py", "service/helpers.py"]));
    expect(functionalModule?.sourceModules).toEqual(expect.arrayContaining(["service"]));
    expect(functionalModule?.communityScore ?? 0).toBeGreaterThan(0);
    expect(functionalModule?.summaryPrompt).toContain("using only cited files");
    expect(index.files.every((file) => Number.isFinite(file.rank))).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "sarif-shell")).toBe(true);
    expect(index.risks.some((risk) => risk.path.startsWith("..") || path.isAbsolute(risk.path))).toBe(false);
  });

it("indexes shallow Rust, Go, and Java symbols and imports as codebase context", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-shallow-languages-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, "tests"));
    await mkdirp(path.join(repo, "cmd/app"));
    await mkdirp(path.join(repo, "pkg/worker"));
    await mkdirp(path.join(repo, "pkg/external"));
    await mkdirp(path.join(repo, "src/main/java/com/acme"));
    await writeFile(path.join(repo, "go.mod"), "module example.com/project\n\ngo 1.22\n", "utf8");
    await writeFile(
      path.join(repo, "src/lib.rs"),
      [
        "mod worker;",
        "pub struct Config {}",
        "pub struct RefConfig<'a> { value: &'a str }",
        "impl Config {",
        "  pub fn load() -> Self { Config {} }",
        "}",
        "impl<'a> RefConfig<'a> {",
        "  pub fn borrowed(&self) -> &'a str { self.value }",
        "}",
        "pub fn start_server() { worker::run_worker(); }",
        "pub fn string_literal_not_call() {",
        "  let _text = \"start_server(\";",
        "}",
        "/*",
        "  start_server();",
        "  }",
        "*/",
        "pub fn after_block_comment() {}",
        "pub mod scoped {",
        "  pub struct ScopedRef<'a> { value: &'a str }",
        "  pub fn module_after_lifetime() {}",
        "}",
        "pub mod raw_scope {",
        "  pub fn raw_string_not_call() {",
        "    let _raw = r#\"",
        "      start_server();",
        "      }",
        "    \"#;",
        "  }",
        "  pub fn after_raw_string() {}",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(repo, "src/worker.rs"), "pub enum Mode { Ready }\npub fn run_worker() {}\n", "utf8");
    await writeFile(
      path.join(repo, "tests/worker_test.rs"),
      "use crate::worker::run_worker;\nuse crate::{start_server};\n\n#[test]\nfn run_worker_smoke() {\n  run_worker();\n  start_server();\n}\n",
      "utf8"
    );
    await writeFile(
      path.join(repo, "pkg/worker/a_runner.go"),
      "package worker\n\ntype Runner struct {}\nfunc (r *Runner) Run() string { return Helper() }\n",
      "utf8"
    );
    await writeFile(
      path.join(repo, "pkg/worker/z_helper.go"),
      [
        "package worker",
        "",
        "func Helper() string { return \"ok\" }",
        "func AfterRawString() string {",
        "  _ = `",
        "    GhostCall()",
        "    }",
        "  `",
        "  return Helper()",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(repo, "pkg/external/external.go"), "package external\n\nfunc Helper() string { return \"external\" }\n", "utf8");
    await writeFile(
      path.join(repo, "cmd/app/main.go"),
      "package main\n\nimport (\n  app \"example.com/project\"\n  worker \"example.com/project/pkg/worker\"\n  other \"github.com/other/project/pkg/external\"\n  \"fmt\"\n)\n\nfunc main() {\n  fmt.Println(worker.Helper())\n  _ = app.RootHelper()\n  _ = other.Helper()\n}\n",
      "utf8"
    );
    await writeFile(path.join(repo, "app.go"), "package project\n\nfunc RootHelper() string { return \"root\" }\n", "utf8");
    await writeFile(path.join(repo, "fmt.go"), "package fmt\n\nfunc Println(v any) {}\n", "utf8");
    await writeFile(path.join(repo, "src/main/java/com/acme/Worker.java"), "package com.acme;\npublic class Worker {\n  public String run() { return \"ok\"; }\n}\n", "utf8");
    await writeFile(
      path.join(repo, "src/main/java/com/acme/App.java"),
      [
        "package com.acme;",
        "import com.acme.Worker;",
        "public class App {",
        "  public String start() { return new Worker().run(); }",
        "  /*",
        "   * Ghost.call();",
        "   * }",
        "   */",
        "  public String url() { return \"https://example.invalid/{notAScope}\"; }",
        "  public String textBlock() {",
        "    String payload = \"\"\"",
        "      Ghost.call();",
        "      }",
        "      \"\"\";",
        "    return payload;",
        "  }",
        "  public String afterTextBlock() { return url(); }",
        "}",
        "class Utility {",
        "  public String helper() { return \"ok\"; }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo });

    expect(index.files.find((file) => file.path === "src/lib.rs")?.language).toBe("rust");
    expect(index.files.find((file) => file.path === "cmd/app/main.go")?.language).toBe("go");
    expect(index.files.find((file) => file.path === "src/main/java/com/acme/App.java")?.language).toBe("java");
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "start_server" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "Config.load" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "RefConfig.borrowed" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "after_block_comment" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "scoped.ScopedRef" && symbol.kind === "type")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "scoped.module_after_lifetime" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "module_after_lifetime")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "raw_scope.after_raw_string" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "app.go" && symbol.qualifiedName === "RootHelper" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "pkg/worker/a_runner.go" && symbol.qualifiedName === "Runner.Run" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "pkg/worker/z_helper.go" && symbol.qualifiedName === "AfterRawString" && symbol.kind === "function")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/main/java/com/acme/App.java" && symbol.qualifiedName === "App.start" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/main/java/com/acme/App.java" && symbol.qualifiedName === "App.url" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/main/java/com/acme/App.java" && symbol.qualifiedName === "App.afterTextBlock" && symbol.kind === "method")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/main/java/com/acme/App.java" && symbol.qualifiedName === "Utility" && symbol.kind === "class")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.path === "src/main/java/com/acme/App.java" && symbol.qualifiedName === "App.Utility")).toBe(false);
    expect(index.imports.some((imp) => imp.path === "src/lib.rs" && imp.specifier === "./worker" && imp.resolvedPath === "src/worker.rs")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "tests/worker_test.rs" && imp.specifier === "crate::worker" && imp.importedName === "run_worker" && imp.resolvedPath === "src/worker.rs")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "tests/worker_test.rs" && imp.specifier === "crate" && imp.importedName === "start_server" && imp.resolvedPath === "src/lib.rs")).toBe(true);
    expect(index.testEdges.some((edge) => edge.path === "tests/worker_test.rs" && edge.reason.includes("run_worker_smoke"))).toBe(true);
    expect(index.imports.some((imp) => imp.path === "cmd/app/main.go" && imp.specifier === "example.com/project" && imp.localName === "app" && imp.resolvedPath === "app.go")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "cmd/app/main.go" && imp.specifier === "example.com/project/pkg/worker" && imp.localName === "worker" && imp.resolvedPath === "pkg/worker/a_runner.go")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "cmd/app/main.go" && imp.specifier === "github.com/other/project/pkg/external" && imp.resolvedPath)).toBe(false);
    expect(index.imports.some((imp) => imp.path === "cmd/app/main.go" && imp.specifier === "fmt" && imp.resolvedPath)).toBe(false);
    expect(index.imports.some((imp) => imp.path === "src/main/java/com/acme/App.java" && imp.specifier === "com.acme.Worker" && imp.resolvedPath === "src/main/java/com/acme/Worker.java")).toBe(true);
    const goHelper = index.symbols.find((symbol) => symbol.path === "pkg/worker/z_helper.go" && symbol.qualifiedName === "Helper");
    const goRootHelper = index.symbols.find((symbol) => symbol.path === "app.go" && symbol.qualifiedName === "RootHelper");
    const rustStartServer = index.symbols.find((symbol) => symbol.path === "src/lib.rs" && symbol.qualifiedName === "start_server");
    const externalHelper = index.symbols.find((symbol) => symbol.path === "pkg/external/external.go" && symbol.qualifiedName === "Helper");
    const localFmtPrintln = index.symbols.find((symbol) => symbol.path === "fmt.go" && symbol.qualifiedName === "Println");
    expect(goHelper?.id).toBeTruthy();
    expect(goRootHelper?.id).toBeTruthy();
    expect(rustStartServer?.id).toBeTruthy();
    expect(externalHelper?.id).toBeTruthy();
    expect(localFmtPrintln?.id).toBeTruthy();
    expect(index.usageSites.some((usage) => usage.path === "cmd/app/main.go" && usage.name === "worker.Helper" && usage.kind === "call" && usage.targetSymbolId === goHelper?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "cmd/app/main.go" && usage.name === "app.RootHelper" && usage.kind === "call" && usage.targetSymbolId === goRootHelper?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "cmd/app/main.go" && usage.name === "other.Helper" && usage.kind === "call" && usage.targetSymbolId === externalHelper?.id)).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "cmd/app/main.go" && usage.name === "fmt.Println" && usage.kind === "call" && usage.targetSymbolId === localFmtPrintln?.id)).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/lib.rs" && usage.name === "start_server" && usage.text.includes("let _text"))).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/lib.rs" && usage.name === "start_server" && usage.text.includes("start_server();"))).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "pkg/worker/z_helper.go" && usage.name === "GhostCall")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/main/java/com/acme/App.java" && usage.name === "Ghost.call")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "tests/worker_test.rs" && usage.name === "start_server" && usage.kind === "call" && usage.targetSymbolId === rustStartServer?.id)).toBe(true);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "IMPORTS" && edge.fromPath === "src/main/java/com/acme/App.java" && edge.toPath === "src/main/java/com/acme/Worker.java")).toBe(true);
  });

it("bounds source indexing and surfaces oversized files as parser evidence", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-large-source-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await writeFile(path.join(repo, "src/small.ts"), "export function small() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "src/large.ts"), `export const large = "${"x".repeat(MAX_INDEXED_SOURCE_BYTES + 256)}"\n`, "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "large-source"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });

    expect(index.files.map((file) => file.path)).toContain("src/large.ts");
    expect(index.symbols.some((symbol) => symbol.path === "src/large.ts")).toBe(false);
    expect(index.parserErrors.some((error) => error.path === "src/large.ts" && error.message.includes("per-file index cap"))).toBe(true);
    expect(index.freshness.parserErrorCount).toBeGreaterThanOrEqual(1);
  });

it("skips oversized external risk reports before JSON parsing", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-large-risk-report-"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), `{"risks":[{"path":"src/app.ts","message":"${"x".repeat(MAX_RISK_REPORT_BYTES)}"}]}\n`, "utf8");

    const risks = await loadExternalRiskSignals(repo, "snapshot", "2026-05-31T00:00:00.000Z");

    expect(risks).toEqual([]);
  });

it("marks freshness stale when ignored external risk reports change", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-freshness-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "first", reason: "first", score: 1 }] }), "utf8");
    execFileSync("git", ["add", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-freshness"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    const fresh = await getFreshness(repo);
    expect(fresh.stale).toBe(false);
    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "second", reason: "second", score: 2 }] }), "utf8");

    const stale = await getFreshness(repo);

    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-risk-reports-changed");
  });

it("marks freshness stale when external risk reports become invalid", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-invalid-freshness-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-invalid-freshness"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(path.join(repo, ".codex/static-analysis/risks.json"), "{not-json", "utf8");

    const stale = await getFreshness(repo);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-risk-reports-changed");
    expect(stale.externalRiskReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/risks.json")).toBe(true);
  });

it("does not read external risk reports through symlinks outside the repository", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-symlink-outside-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-risk-symlink-outside-target-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(outside, "risks.json"), JSON.stringify({ risks: [{ path: "src/app.ts", signal: "outside-risk", reason: "outside", score: 9 }] }), "utf8");
    await symlink(path.join(outside, "risks.json"), path.join(repo, ".codex/static-analysis/risks.json"));
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "risk-symlink-outside"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.risks.some((risk) => risk.signal === "outside-risk")).toBe(false);
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/risks.json"]).toBeUndefined();
  });

it("marks freshness stale when ignored external symbol reports change", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-freshness-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-freshness"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    const fresh = await getFreshness(repo);
    expect(fresh.stale).toBe(false);
    await writeFile(
      path.join(repo, ".codex/static-analysis/symbols.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "external-app", name: "externalApp", qualifiedName: "externalApp", kind: "function", path: "src/app.ts", line: 1 }]
      }),
      "utf8"
    );

    const stale = await getFreshness(repo);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-symbol-reports-changed");
    const refreshed = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(refreshed.symbols.some((symbol) => symbol.qualifiedName === "externalApp" && symbol.source === "static-analysis")).toBe(true);
  });

it("marks freshness stale when ignored symbol-named reports become invalid", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-invalid-freshness-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-invalid-freshness"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo, writeArtifacts: true });

    await writeFile(path.join(repo, ".codex/static-analysis/symbols.json"), "{not-json", "utf8");

    const stale = await getFreshness(repo);
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe("external-symbol-reports-changed");
    expect(stale.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/symbols.json")).toBe(true);
  });

it("surfaces invalid symbol report diagnostics as parser errors", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-invalid-parser-error-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, ".codex/static-analysis/symbols.json"), "{not-json", "utf8");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-invalid-parser-error"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.parserErrors.some((error) => error.path === ".codex/static-analysis/symbols.json" && error.message.includes("external symbol report"))).toBe(true);
  });

it("does not hash or diagnose external symbol reports through symlinks outside the repository", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-symlink-outside-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-symlink-outside-target-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(path.join(outside, "symbols.json"), "{not-json", "utf8");
    await symlink(path.join(outside, "symbols.json"), path.join(repo, ".codex/static-analysis/symbols.json"));
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-symlink-outside"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportHashes?.[".codex/static-analysis/symbols.json"]).toBeUndefined();
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/symbols.json")).toBe(false);
    expect(index.parserErrors.some((error) => error.path === ".codex/static-analysis/symbols.json")).toBe(false);
  });

it("labels valid JSON symbol report schema or path failures separately from invalid JSON", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-symbol-invalid-shape-parser-error-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/symbols.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "missing", name: "missing", qualifiedName: "missing", kind: "function", path: "src/missing.ts", line: 1 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "symbol-invalid-shape-parser-error"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    const diagnostic = index.parserErrors.find((error) => error.path === ".codex/static-analysis/symbols.json" && error.message.includes("external symbol report"));
    expect(diagnostic?.message).toContain("valid JSON");
    expect(diagnostic?.message).not.toContain("invalid JSON");
  });

it("surfaces new generic custom symbol reports with invalid referenced paths", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-invalid-path-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ id: "missing", name: "missing", qualifiedName: "missing", kind: "function", path: "src/missing.ts", line: 1 }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-invalid-path"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json" && diagnostic.reason === "invalid-symbol-report")).toBe(true);
    expect(index.parserErrors.some((error) => error.path === ".codex/static-analysis/custom.json" && error.message.includes("valid JSON"))).toBe(true);
    expect(index.freshness.externalRiskReportHashes?.[".codex/static-analysis/custom.json"]).toBeUndefined();
  });

it("surfaces symbol-shaped JSON with malformed symbol entries", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-custom-symbol-malformed-entry-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "src"));
    await mkdirp(path.join(repo, ".codex/static-analysis"));
    await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
    await writeFile(path.join(repo, "src/app.ts"), "export function app() { return 1 }\n", "utf8");
    await writeFile(
      path.join(repo, ".codex/static-analysis/custom.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [{ name: "bad" }]
      }),
      "utf8"
    );
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "custom-symbol-malformed-entry"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: true });
    expect(index.freshness.externalSymbolReportDiagnostics?.some((diagnostic) => diagnostic.path === ".codex/static-analysis/custom.json" && diagnostic.reason === "invalid-symbol-report")).toBe(true);
    expect(index.symbols.some((symbol) => symbol.source === "static-analysis" && symbol.qualifiedName === "bad")).toBe(false);
  });
});
