import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitState } from "../src/git.js";
import { buildIndex, buildIndexLocked, loadIndex } from "../src/indexer.js";
import { loadExternalRiskSignals } from "../src/risk-ingest.js";
import { recordSessionMemory } from "../src/session-memory.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
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
    expect(index.files.every((file) => Number.isFinite(file.rank))).toBe(true);
    expect(index.risks.some((risk) => risk.path === "src/ops.ts" && risk.signal === "sarif-shell")).toBe(true);
    expect(index.risks.some((risk) => risk.path.startsWith("..") || path.isAbsolute(risk.path))).toBe(false);
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
    const facts = await readFile(path.join(repo, ".codex/codebase/facts.ndjson"), "utf8");
    expect(readme).toContain("Codexa Codebase Context");
    expect(readme).not.toContain(repo);
    expect(contract).toContain("Codexa Codex Contract");
    expect(contract).toContain("change_plan");
    expect(contract).toContain("post_edit_review");
    expect(contract).not.toContain(repo);
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

  it("uses metadata hashes for large or non-source dirty files", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await writeFile(path.join(repo, "large-output.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
    const status = await statusQuery(repo);

    expect(status.freshness.dirtyFiles).toContain("large-output.bin");
    expect(status.freshness.dirtyFileHashes["large-output.bin"]).toMatch(/^metadata:/u);
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
    expect((result.data as { files: Array<{ path: string }> }).files[0].path).toBe("src/unique-marker.ts");

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

  it("separates evidence tiers and uses natural retrieval instead of broad-task fallback", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const manifestImpact = await impactQuery(repo, { file: "sample_api/packages/project.media.json" }, { autoRefresh: false });
    expect(manifestImpact.text).toContain("Authoritative read first:");
    expect(manifestImpact.text).toContain("Heuristic expansion:");
    const impactData = manifestImpact.data as {
      selectedFiles: string[];
      affectedFiles: Array<{ file: { path: string } }>;
      evidenceTiers: { authoritative: Array<{ file: { path: string } }>; heuristic: Array<{ file: { path: string } }> };
      quality: { level: string };
      value: { value: string };
    };
    expect(impactData.evidenceTiers.authoritative.some((entry) => entry.file.path === "sample_api/packages/project.media.json")).toBe(true);
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

  it("rejects non-manifest JSON from node-manifest indexing", async () => {
    const repo = await createManifestGateFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    expect(index.symbols.some((symbol) => symbol.path === "docs/report.json" && symbol.kind === "node")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "sample_api/packages/project.invalid.json" && symbol.kind === "node")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "docs/report.json" && usage.name === "fake.node")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "sample_api/packages/project.invalid.json" && usage.name === "fake.node")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "docs/report.json" && risk.signal === "node-manifest")).toBe(false);
    expect(index.risks.some((risk) => risk.path === "sample_api/packages/project.invalid.json" && risk.signal === "node-manifest")).toBe(false);
    expect(index.parserErrors.some((error) => error.path === "docs/broken.json")).toBe(true);
    expect(index.graphEdges.some((edge) => edge.fromPath === "docs/report.json" || edge.toPath === "docs/report.json")).toBe(false);
    expect(index.symbols.some((symbol) => symbol.path === "sample_api/packages/project.media.json" && symbol.kind === "node")).toBe(true);
  });

  it("keeps quoted dotted references but skips bare property chains", async () => {
    const repo = await createDottedReferenceFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    const generateSymbol = index.symbols.find((symbol) => symbol.path === "src/generate.ts" && symbol.name === "generate");
    const barSymbol = index.symbols.find((symbol) => symbol.path === "src/bar.ts" && symbol.name === "bar");

    expect(generateSymbol).toBeTruthy();
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.name === "image.generate" && usage.targetSymbolId === generateSymbol?.id)).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.name === "foo.bar")).toBe(false);
    expect(index.usageSites.some((usage) => usage.path === "src/reference.ts" && usage.targetSymbolId === barSymbol?.id)).toBe(false);
  });

  it("prefers adapters in the same package root as the manifest", async () => {
    const repo = await createManifestLocalityFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    const edges = index.graphEdges.filter(
      (edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/package.json"
    );
    expect(edges.map((edge) => edge.toPath)).toEqual(["packages/foo/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/package.json" && edge.toPath === "packages/bar/adapters/image_generate.py")).toBe(false);
    const nestedEdges = index.graphEdges.filter((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/sub/package.json");
    expect(nestedEdges.map((edge) => edge.toPath)).toEqual(["packages/foo/sub/adapters/image_generate.py"]);
    expect(index.graphEdges.some((edge) => edge.edgeKind === "ADAPTER_REFERENCED_BY_MANIFEST" && edge.fromPath === "packages/foo/sub/package.json" && edge.toPath === "packages/foo/adapters/image_generate.py")).toBe(false);
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

    const broadWorkflowRepo = await createBroadWorkflowFixtureRepo();
    const broadWorkflow = await focusBriefQuery(
      broadWorkflowRepo,
      {
        task: "How does the normalize_noiseflow route workflow behave and what should be tested?",
        diff: false,
        tokenBudget: 1300,
        limit: 4
      },
      { autoRefresh: false }
    );
    const broadFocusPaths = (broadWorkflow.data as { focusFiles: Array<{ path: string }> }).focusFiles.map((file) => file.path);
    expect(broadFocusPaths).toContain("service_noiseflow/app.py");
    expect(broadFocusPaths).toContain("service_noiseflow/helpers.py");
    expect(broadFocusPaths).toContain("tests/test_noiseflow.py");
    expect(broadFocusPaths.some((filePath) => filePath.startsWith("src/"))).toBe(false);

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

  it("indexes Markdown docs as document facts and keeps changed docs out of unindexed gaps", async () => {
    const repo = await createDocFixtureRepo();
    const index = await buildIndex({ repoRoot: repo });

    expect(index.files.find((file) => file.path === "README.md")?.language).toBe("markdown");
    expect(index.files.find((file) => file.path === "docs/workflow.md")?.language).toBe("markdown");
    expect(index.symbols.some((symbol) => symbol.path === "README.md" && symbol.name === "Runtime Guide" && symbol.source === "markdown")).toBe(true);
    expect(index.usageSites.some((usage) => usage.path === "docs/workflow.md" && usage.text.includes("pre edit accountability"))).toBe(true);
    expect(index.imports.some((imp) => imp.path === "README.md" && imp.specifier === "./src/runtime.ts" && imp.resolvedPath === "src/runtime.ts")).toBe(true);
    expect(index.imports.some((imp) => imp.path === "docs/workflow.md" && imp.specifier === "../src/runtime.ts" && imp.resolvedPath === "src/runtime.ts")).toBe(true);

    await writeFile(
      path.join(repo, "README.md"),
      "# Runtime Guide\n\nChanged docs still reference [runtime](src/runtime.ts) and `npm run test`.\n",
      "utf8"
    );
    const diff = await diffImpactQuery(repo, { autoRefresh: false });
    expect((diff.data as { unindexedChanged: string[] }).unindexedChanged).not.toContain("README.md");
    expect(diff.text).not.toContain("Changed but not indexed:\n- README.md");
    expect(diff.text).toContain("root [docs/markdown]");
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

  it("promotes indirect recommended tests into impact read-first files", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const impact = await impactQuery(repo, { file: "service/helpers.py" }, { autoRefresh: false });
    const selected = (impact.data as { selectedFiles: string[] }).selectedFiles;
    expect(selected).toContain("service/helpers.py");
    expect(selected).toContain("service/app.py");
    expect(selected).toContain("tests/test_app.py");
    expect(impact.text).toContain("recommended test");
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
    expect((focus.data as { quality: { counts: { derived: number } } }).quality.counts.derived).toBeGreaterThan(0);

    const fallbackFocus = await focusBriefQuery(repo, { task: "narlple frondicate zindle", diff: false, limit: 4, tokenBudget: 900 }, { autoRefresh: false });
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.fallback).toBeGreaterThan(0);
    expect((fallbackFocus.data as { quality: { counts: { fallback: number; derived: number } } }).quality.counts.derived).toBe(0);

    const ambiguousEdit = await taskBriefQuery(repo, { task: "Change behavior safely", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    const ambiguousData = ambiguousEdit.data as {
      packetVerdict?: string;
      intentConfidence?: { editReady: boolean; anchors: string[]; missingAnchors: string[] };
      quality?: { level: string; reasons: string[] };
    };
    expect(["raw-search-better", "needs-target"]).toContain(ambiguousData.packetVerdict);
    expect(ambiguousData.intentConfidence?.editReady).toBe(false);
    expect(ambiguousData.intentConfidence?.anchors.every((anchor) => !anchor.includes("test"))).toBe(true);
    expect(ambiguousData.packetVerdict).not.toBe("edit-ready");
    expect(["low", "medium"]).toContain(ambiguousData.quality?.level);
    expect(ambiguousEdit.text).toContain("Recommended next MCP call: search");

    const ambiguousPlan = await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "ambiguous-change-plan"
      },
      { autoRefresh: false }
    );
    const ambiguousPlanData = ambiguousPlan.data as {
      editReadiness?: { editable: boolean; status: string; snapshotBlocked: boolean };
      plannedEditTargets?: string[];
      tests?: unknown[];
      snapshot?: unknown;
      snapshotBlock?: { taskId: string; path: string };
    };
    expect(ambiguousPlan.text).toContain("Edit readiness: orientation-only");
    expect(ambiguousPlan.text).toContain("Task snapshot: not saved");
    expect(ambiguousPlanData.editReadiness).toMatchObject({ editable: false, status: "orientation-only", snapshotBlocked: true });
    expect(ambiguousPlanData.plannedEditTargets).toEqual([]);
    expect(ambiguousPlanData.tests).toEqual([]);
    expect(ambiguousPlanData.snapshot).toBeUndefined();
    expect(ambiguousPlanData.snapshotBlock).toMatchObject({
      taskId: "ambiguous-change-plan",
      path: ".codex/cache/codexa-tasks/ambiguous-change-plan.blocked.json"
    });
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/ambiguous-change-plan.json"), "utf8")).rejects.toThrow();
    const ambiguousLatest = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "utf8")) as {
      taskId: string;
      path: string;
      blocked: boolean;
    };
    expect(ambiguousLatest).toMatchObject({
      taskId: "ambiguous-change-plan",
      path: "ambiguous-change-plan.blocked.json",
      blocked: true
    });

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
    expect((plan.data as { editReadiness?: { editable: boolean; status: string } }).editReadiness).toMatchObject({ editable: true, status: "edit-ready" });
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
    const savedPlanSnapshot = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-tasks/fixture-normalize.json"), "utf8")) as {
      requiredWorkflowChecks: unknown[];
      requiredDependencyChecks: unknown[];
    };
    expect(JSON.stringify(savedPlanSnapshot)).toContain("symbolBaseline");
    expect(JSON.stringify(savedPlanSnapshot)).not.toContain(repo);
    expect(savedPlanSnapshot.requiredWorkflowChecks.length).toBeGreaterThan(0);
    expect(savedPlanSnapshot.requiredDependencyChecks.length).toBeGreaterThan(0);

    await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "reused-task-id"
      },
      { autoRefresh: false }
    );
    const reusedSnapshotText = await readFile(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.json"), "utf8");
    const reusedSnapshot = JSON.parse(reusedSnapshotText) as { createdAt: string };
    await mkdir(path.join(repo, ".codex/cache/codexa-task-snapshots"), { recursive: true });
    await writeFile(path.join(repo, ".codex/cache/codexa-task-snapshots/reused-task-id.json"), reusedSnapshotText, "utf8");
    await writeFile(
      path.join(repo, ".codex/cache/codexa-task-snapshots/latest.json"),
      `${JSON.stringify({ schemaVersion: 1, taskId: "reused-task-id", path: "reused-task-id.json", createdAt: reusedSnapshot.createdAt })}\n`,
      "utf8"
    );
    await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "reused-task-id"
      },
      { autoRefresh: false }
    );
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/reused-task-id.json"), "utf8")).rejects.toThrow();
    const reusedTaskReview = await postEditReviewQuery(repo, { taskId: "reused-task-id", ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const reusedTaskData = reusedTaskReview.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string };
    };
    expect(reusedTaskData.snapshot).toBeUndefined();
    expect(reusedTaskData.snapshotLoad).toMatchObject({ taskId: "reused-task-id", missingReason: "blocked-plan" });

    const blockedPlan = await changePlanQuery(
      repo,
      {
        task: "Change behavior safely",
        diff: false,
        limit: 6,
        tokenBudget: 1200,
        saveSnapshot: true,
        taskId: "blocked-after-valid"
      },
      { autoRefresh: false }
    );
    expect(blockedPlan.text).toContain("Edit readiness: orientation-only");
    await expect(readFile(path.join(repo, ".codex/cache/codexa-tasks/blocked-after-valid.json"), "utf8")).rejects.toThrow();
    const blockedReview = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const blockedReviewData = blockedReview.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string; error?: string };
      outcome: { persisted: boolean };
    };
    expect(blockedReview.text).toContain("Snapshot: unavailable (blocked-plan)");
    expect(blockedReviewData.snapshot).toBeUndefined();
    expect(blockedReviewData.snapshotLoad).toMatchObject({ taskId: "blocked-after-valid", missingReason: "blocked-plan" });
    expect(blockedReviewData.snapshotLoad.error).toBeTruthy();
    expect(blockedReviewData.outcome.persisted).toBe(false);

    await recordSessionMemory({
      repoRoot: repo,
      taskId: "blocked-after-valid",
      freshness: blockedPlan.freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:blocked-task",
          summary: "blocked-after-valid memory stays task-scoped.",
          provenance: "agent-asserted",
          confidence: "derived",
          evidenceTier: "derived",
          scope: { files: [] }
        }
      ]
    });
    await recordSessionMemory({
      repoRoot: repo,
      taskId: "unrelated-task",
      freshness: blockedPlan.freshness,
      entries: [
        {
          kind: "decision",
          key: "decision:unrelated-task",
          summary: "unrelated memory should not leak into blocked review.",
          provenance: "agent-asserted",
          confidence: "derived",
          evidenceTier: "derived",
          scope: { files: [] }
        }
      ]
    });
    const blockedMemoryReview = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    expect(blockedMemoryReview.text).toContain("blocked-after-valid memory stays task-scoped");
    expect(blockedMemoryReview.text).not.toContain("unrelated memory should not leak");

    await writeFile(path.join(repo, ".codex/cache/codexa-tasks/latest.json"), "{not json", "utf8");
    const recoveredBlocked = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const recoveredBlockedData = recoveredBlocked.data as {
      snapshot?: unknown;
      snapshotLoad: { taskId?: string; missingReason?: string; recoveredLatest?: boolean };
    };
    expect(recoveredBlockedData.snapshot).toBeUndefined();
    expect(recoveredBlockedData.snapshotLoad).toMatchObject({
      taskId: "blocked-after-valid",
      missingReason: "blocked-plan",
      recoveredLatest: true
    });

    await changePlanQuery(
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
      modifiedSymbols: string[];
      modifiedPublicSymbols: string[];
      missedLikelyTests: Array<{ path: string }>;
      workflowChecks: Array<{ status: string }>;
      dependencyChecks: Array<{ status: string }>;
      outcome: {
        path: string;
        verdict: string;
        calibrationLabels: string[];
        testsNotRun: Array<{ path: string }>;
        modifiedSymbols: string[];
        modifiedPublicSymbols: string[];
        missedLikelyTests: Array<{ path: string }>;
        hookSummary: { verdict: string; missedLikelyTests: number };
      };
    };
    expect(reviewData.verdict).not.toBe("continue");
    expect(reviewData.outcome.verdict).toBe(reviewData.verdict);
    expect(reviewData.outcome.path).toMatch(/^\.codex\/cache\/codexa-outcomes\/.+\.json$/u);
    expect(reviewData.outcome.calibrationLabels).toContain("unplanned-edits");
    expect(reviewData.outcome.calibrationLabels).toContain("modified-public-symbols");
    expect(reviewData.outcome.testsNotRun.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.outcome.missedLikelyTests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.outcome.modifiedSymbols.length).toBeGreaterThan(0);
    expect(reviewData.outcome.modifiedSymbols.some((symbol) => symbol.includes("normalize"))).toBe(true);
    expect(reviewData.outcome.hookSummary.verdict).toBe(reviewData.verdict);
    expect(reviewData.missedLikelyTests.some((test) => test.path === "tests/test_app.py")).toBe(true);
    expect(reviewData.workflowChecks.length).toBeGreaterThan(0);
    expect(reviewData.dependencyChecks.length).toBeGreaterThan(0);
    const persistedOutcomeText = await readFile(path.join(repo, reviewData.outcome.path), "utf8");
    expect(JSON.parse(persistedOutcomeText).verdict).toBe(reviewData.verdict);
    expect(persistedOutcomeText).not.toContain(repo);
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

  it("keeps planned post-edit reviews accountable without forcing replan when tests are reported", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change helper normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "planned-helper-edit"
      },
      { autoRefresh: false }
    );
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/planned-helper-edit.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    snapshot.plannedTests.push({
      path: "tests/manual_regression.py",
      reason: "manual regression saved in plan snapshot",
      rank: 99,
      evidenceTier: "authoritative"
    });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().upper()\n", "utf8");

    const needsTests = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranTests: [] }, { autoRefresh: true });
    const needsTestsData = needsTests.data as {
      verdict: string;
      unplannedEditedFiles: string[];
      modifiedSymbols: string[];
      missedLikelyTests: Array<{ path: string }>;
    };
    expect(needsTestsData.unplannedEditedFiles).toEqual([]);
    expect(needsTestsData.verdict).toBe("run_tests");
    expect(needsTestsData.modifiedSymbols.some((symbol) => symbol.includes("normalize"))).toBe(true);
    expect(needsTestsData.missedLikelyTests.map((test) => test.path)).toContain("tests/test_app.py");
    expect(needsTestsData.missedLikelyTests.map((test) => test.path)).toContain("tests/manual_regression.py");

    const pytestTargeted = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest tests/test_app.py"] }, { autoRefresh: false });
    const pytestTargetedData = pytestTargeted.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(pytestTargetedData.verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe("covered");
    expect(pytestTargetedData.testsNotRun.map((test) => test.path)).toContain("tests/manual_regression.py");

    const pythonModulePytest = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["python -m pytest tests/test_app.py"] }, { autoRefresh: false });
    expect((pythonModulePytest.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const absolutePytestTarget = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: [`pytest ${path.join(repo, "tests/test_app.py")}`] }, { autoRefresh: false });
    expect((absolutePytestTarget.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestNodeIdTarget = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest tests/test_app.py::test_route"] }, { autoRefresh: false });
    expect((pytestNodeIdTarget.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestCollectOnly = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest --collect-only tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestCollectOnly.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestVersion = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest --version"] }, { autoRefresh: false });
    expect((pytestVersion.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestVerbose = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest -v tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestVerbose.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe(
      "covered"
    );

    const pytestHelp = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest -h tests/test_app.py"] }, { autoRefresh: false });
    expect((pytestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/test_app.py");

    const pytestAll = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranCommands: ["pytest"] }, { autoRefresh: false });
    const pytestAllData = pytestAll.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(pytestAllData.verificationLedger.find((entry) => entry.target === "tests/test_app.py")?.status).toBe("covered");
    expect(pytestAllData.testsNotRun.map((test) => test.path)).toContain("tests/manual_regression.py");

    const afterTests = await postEditReviewQuery(repo, { taskId: "planned-helper-edit", ranTests: needsTestsData.missedLikelyTests.map((test) => test.path) }, { autoRefresh: false });
    const afterTestsData = afterTests.data as {
      verdict: string;
      testsNotRun: unknown[];
      missedLikelyTests: unknown[];
      workflowChecks: Array<{ status: string }>;
      dependencyChecks: Array<{ status: string }>;
      outcome: { hookSummary: { nextAction: string }; calibrationLabels: string[] };
    };
    expect(afterTestsData.verdict).toBe("continue");
    expect(afterTestsData.testsNotRun).toEqual([]);
    expect(afterTestsData.missedLikelyTests).toEqual([]);
    expect(afterTestsData.workflowChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterTestsData.dependencyChecks.every((check) => check.status === "covered")).toBe(true);
    expect(afterTestsData.outcome.hookSummary.nextAction).toBe("continue with normal diff review");
    expect(afterTestsData.outcome.calibrationLabels).not.toContain("missing-recommended-tests");
  });

  it("accounts for ranCommands through package-script coverage without over-covering tests", async () => {
    const repo = await createVerificationCoverageFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change shared behavior safely",
        files: ["src/shared.ts"],
        changeType: "behavior",
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "verification-coverage"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toUpperCase() }\n", "utf8");

    const typecheckOnly = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run typecheck"] }, { autoRefresh: true });
    const typecheckData = typecheckOnly.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
    };
    expect(typecheckData.verificationCoverage.map((entry) => entry.kind)).toContain("typescript-syntax");
    expect(typecheckData.verificationCoverage.map((entry) => entry.kind)).not.toContain("build");
    expect(typecheckData.testsNotRun.map((test) => test.path)).toEqual(expect.arrayContaining(["tests/shared.test.ts", "tests/other.test.ts"]));
    expect(typecheckData.verificationLedger.filter((entry) => entry.kind === "test").every((entry) => entry.status === "missing")).toBe(true);

    const buildOnly = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run build"] }, { autoRefresh: false });
    const buildOnlyData = buildOnly.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(buildOnlyData.testsNotRun.map((test) => test.path)).toEqual(expect.arrayContaining(["tests/shared.test.ts", "tests/other.test.ts"]));
    expect(buildOnlyData.verificationCoverage.map((entry) => entry.kind)).toContain("typescript-syntax");
    expect(buildOnlyData.verificationCoverage.map((entry) => entry.kind)).not.toContain("build");

    const targeted = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -- tests/shared.test.ts"] }, { autoRefresh: false });
    const targetedData = targeted.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
    };
    expect(targetedData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(targetedData.verificationLedger.find((entry) => entry.target === "tests/other.test.ts")?.status).toBe("missing");
    expect(targetedData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const directVitest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest run tests/shared.test.ts"] }, { autoRefresh: false });
    const directVitestData = directVitest.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(directVitestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(directVitestData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const directVitestAbsoluteTarget = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`vitest run ${path.join(repo, "tests/shared.test.ts")}`] }, { autoRefresh: false });
    const directVitestAbsoluteData = directVitestAbsoluteTarget.data as { verificationLedger: Array<{ target: string; status: string }> };
    expect(directVitestAbsoluteData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");

    const directVitestVersion = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest --version"] }, { autoRefresh: false });
    expect((directVitestVersion.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const directVitestHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest -h"] }, { autoRefresh: false });
    expect((directVitestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const noEvidenceCommand = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["echo done"] }, { autoRefresh: false });
    const noEvidenceCommandData = noEvidenceCommand.data as { driftReasons: string[]; testsNotRun: Array<{ path: string }> };
    expect(noEvidenceCommandData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(noEvidenceCommandData.driftReasons).toContain("recommended tests have not been accounted for");
    expect(noEvidenceCommandData.driftReasons.some((reason) => reason.includes("remain unaccounted"))).toBe(false);

    const commandShapedRanTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranTests: ["npm run test -- tests/shared.test.ts"] }, { autoRefresh: false });
    const commandShapedRanTestData = commandShapedRanTest.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(commandShapedRanTestData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(commandShapedRanTestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("missing");

    const exactRanTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranTests: ["./tests/shared.test.ts"] }, { autoRefresh: false });
    const exactRanTestData = exactRanTest.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(exactRanTestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(exactRanTestData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const forwardedHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -- --help"] }, { autoRefresh: false });
    expect((forwardedHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmRunHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -h"] }, { autoRefresh: false });
    expect((npmRunHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmTestHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm test -h"] }, { autoRefresh: false });
    expect((npmTestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmBuildHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run build -h"] }, { autoRefresh: false });
    const npmBuildHelpData = npmBuildHelp.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(npmBuildHelpData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(npmBuildHelpData.verificationCoverage.map((entry) => entry.kind)).not.toContain("typescript-syntax");

    const yarnRun = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["yarn run test"] }, { autoRefresh: false });
    expect((yarnRun.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const outsideRepo = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["cd /tmp && npm test"] }, { autoRefresh: false });
    expect((outsideRepo.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const waivedOne = await postEditReviewQuery(repo, { taskId: "verification-coverage", waivedChecks: ["tests/shared.test.ts"] }, { autoRefresh: false });
    const waivedOneData = waivedOne.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(waivedOneData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("waived");
    expect(waivedOneData.verificationLedger.find((entry) => entry.target === "tests/other.test.ts")?.status).toBe("missing");
    expect(waivedOneData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const waivedAll = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        waivers: [
          { kind: "test", target: "tests/shared.test.ts", reason: "manual browser coverage for shared" },
          { kind: "test", target: "tests/other.test.ts", reason: "manual browser coverage for other" }
        ]
      },
      { autoRefresh: false }
    );
    const waivedAllData = waivedAll.data as { verdict: string; testsNotRun: unknown[]; verificationLedger: Array<{ target: string; waiverReason?: string }>; outcome: { calibrationLabels: string[]; waivers: unknown[] } };
    expect(waivedAllData.testsNotRun).toEqual([]);
    expect(waivedAllData.verdict).toBe("inspect");
    expect(waivedAllData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.waiverReason).toBe("manual browser coverage for shared");
    expect(waivedAllData.outcome.waivers).toHaveLength(2);
    expect(waivedAllData.outcome.calibrationLabels).toContain("waived-behavior-test");

    const unrelatedWaiver = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranTests: [],
        ranCommands: [],
        waivers: [{ kind: "dependency", target: "unrelated dependency", reason: "not touched" }]
      },
      { autoRefresh: false }
    );
    const unrelatedWaiverData = unrelatedWaiver.data as { testsNotRun: Array<{ path: string }>; driftReasons: string[] };
    expect(unrelatedWaiverData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(unrelatedWaiverData.driftReasons).toContain("recommended tests have not been accounted for");

    const aggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run check"] }, { autoRefresh: false });
    const aggregateData = aggregate.data as {
      testsNotRun: unknown[];
      missedLikelyTests: unknown[];
      verificationCoverage: Array<{ kind: string; source: string; scope?: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
      outcome: { calibrationLabels: string[]; ranCommands: string[]; verificationLedger: unknown[] };
    };
    expect(aggregateData.testsNotRun).toEqual([]);
    expect(aggregateData.missedLikelyTests).toEqual([]);
    expect(aggregateData.verificationCoverage.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
    expect(aggregateData.verificationLedger.some((entry) => entry.evidence.some((item) => item.includes("npm run check")))).toBe(true);
    expect(aggregateData.verificationLedger.filter((entry) => entry.kind === "test").every((entry) => entry.status === "covered")).toBe(true);
    expect(aggregateData.outcome.ranCommands).toEqual(["npm run check"]);
    expect(aggregateData.outcome.verificationLedger.length).toBeGreaterThan(0);
    expect(aggregateData.outcome.calibrationLabels).toContain("aggregate-command-coverage");
    expect(aggregateData.outcome.calibrationLabels).toContain("false-missing-test-warning-avoided");
    expect(aggregateData.outcome.calibrationLabels).not.toContain("missing-recommended-tests");

    const successfulReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 0, durationMs: 1234, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const successfulReportData = successfulReport.data as {
      testsNotRun: unknown[];
      ranCommandReports: Array<{ command: string; exitCode?: number; durationMs?: number }>;
      commandEnvelopes: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
      verificationProvenance: typeof CURRENT_VERIFICATION_PROVENANCE;
      verificationCoverage: Array<{ kind: string; exitCode?: number; durationMs?: number; outputSummary?: string; commandEnvelope?: { packageManager?: string; scriptName?: string } }>;
      outcome: {
        ranCommandReports: Array<{ command: string; cwd?: string; stdoutSummary?: string }>;
        commandEnvelopes: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
        verificationProvenance: typeof CURRENT_VERIFICATION_PROVENANCE;
        calibrationLabels: string[];
      };
    };
    expect(successfulReportData.testsNotRun).toEqual([]);
    expect(successfulReportData.ranCommandReports[0]).toMatchObject({ command: "npm run check", exitCode: 0, durationMs: 1234 });
    expect(successfulReportData.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "derived-from-report", scopeStatus: "repo" });
    expect(successfulReportData.commandEnvelopes[0]).toMatchObject({ classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion });
    expect(successfulReportData.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(successfulReportData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.exitCode === 0 && entry.outputSummary?.includes("vitest passed"))).toBe(true);
    expect(successfulReportData.verificationCoverage.some((entry) => entry.commandEnvelope?.packageManager === "npm" && entry.commandEnvelope.scriptName === "check")).toBe(true);
    expect(successfulReportData.outcome.ranCommandReports[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", stdoutSummary: "typecheck and vitest passed" });
    expect(successfulReportData.outcome.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "derived-from-report" });
    expect(successfulReportData.outcome.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(successfulReportData.outcome.calibrationLabels).toContain("aggregate-command-coverage");

    const secretArgReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm test -- --token s3cr3t-value --reporter /var/private-report.json",
            cwd: repo,
            exitCode: 0,
            args: ["--", "--token", "s3cr3t-value", "--reporter", "/var/private-report.json"],
            stdoutSummary: "Bearer s3cr3t-value"
          }
        ]
      },
      { autoRefresh: false }
    );
    const serializedSecretReport = JSON.stringify(secretArgReport.data);
    expect(serializedSecretReport).not.toContain("s3cr3t-value");
    expect(serializedSecretReport).not.toContain("/var/private-report.json");
    expect(serializedSecretReport).toContain("<redacted>");
    expect(serializedSecretReport).toContain("<abs-path>");

    const relativeSecretReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm test -- --reporter ../private-report.json --config ./secret.json",
            cwd: "../outside",
            exitCode: 0,
            args: ["--", "--reporter", "../private-report.json", "--config", "./secret.json"],
            stdoutSummary: "wrote ../private-report.json and ./secret.json"
          }
        ]
      },
      { autoRefresh: false }
    );
    const serializedRelativeReport = JSON.stringify(relativeSecretReport.data);
    expect(serializedRelativeReport).not.toContain("../outside");
    expect(serializedRelativeReport).not.toContain("../private-report.json");
    expect(serializedRelativeReport).not.toContain("./secret.json");
    expect(serializedRelativeReport).toContain("<outside-repo>");
    expect(serializedRelativeReport).toContain("<rel-path>");

    const persistedSanitizationReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranTests: [path.join(repo, "tests/shared.test.ts")],
        waivedChecks: [`manual check at ${path.join(repo, "private-check.log")}`],
        waivers: [{ kind: "test", target: path.join(repo, "tests/shared.test.ts"), reason: `manual run at ${path.join(repo, "private-report.log")}` }]
      },
      { autoRefresh: false }
    );
    const persistedSanitizationData = persistedSanitizationReport.data as { outcome: { path: string } };
    const persistedSanitization = await readFile(path.join(repo, persistedSanitizationData.outcome.path), "utf8");
    expect(persistedSanitization).not.toContain(repo);
    expect(persistedSanitization).toContain("<repo>");

    const reportedEnvelope = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm run check",
            cwd: repo,
            packageManager: "npm",
            packageRoot: ".",
            scriptName: "check",
            args: [],
            exitCode: 0,
            outputSummary: "structured wrapper passed"
          }
        ]
      },
      { autoRefresh: false }
    );
    const reportedEnvelopeData = reportedEnvelope.data as {
      testsNotRun: unknown[];
      commandEnvelopes: Array<{ command: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; args: string[] }>;
      verificationCoverage: Array<{ kind: string; source: string; outputSummary?: string; commandEnvelope?: { source?: string; scriptName?: string } }>;
      outcome: { commandEnvelopes: Array<{ command: string; cwd?: string; source?: string; scriptName?: string; outputSummary?: string }> };
    };
    expect(reportedEnvelopeData.testsNotRun).toEqual([]);
    expect(reportedEnvelopeData.commandEnvelopes[0]).toMatchObject({ command: "npm run check", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "reported", args: [] });
    expect(reportedEnvelopeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.commandEnvelope?.source === "reported" && entry.outputSummary?.includes("structured wrapper passed"))).toBe(true);
    expect(reportedEnvelopeData.outcome.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", source: "reported", scriptName: "check", outputSummary: expect.stringContaining("structured wrapper passed") });

    const spoofedEnvelope = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "echo done", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0, stdoutSummary: "not actually tests" }]
      },
      { autoRefresh: false }
    );
    const spoofedEnvelopeData = spoofedEnvelope.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ source?: string; packageManager?: string; scriptName?: string }>;
    };
    expect(spoofedEnvelopeData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(spoofedEnvelopeData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "reported command envelope does not match command text" })]));
    expect(spoofedEnvelopeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(spoofedEnvelopeData.commandEnvelopes[0]).toMatchObject({ source: "reported", packageManager: "npm", scriptName: "test" });

    const missingCwdReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", exitCode: 0, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const missingCwdReportData = missingCwdReport.data as {
      driftReasons: string[];
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
    };
    expect(missingCwdReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingCwdReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));
    expect(missingCwdReportData.driftReasons).toContain("recommended tests have not been accounted for");

    const missingCwdReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", exitCode: 0, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const missingCwdReportWithDuplicateRawData = missingCwdReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string }>;
    };
    expect(missingCwdReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingCwdReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));
    expect(missingCwdReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(missingCwdReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("missing-cwd");

    const outsideCwdReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: "/tmp/codexa-outside", exitCode: 0, stdoutSummary: "outside ok" }]
      },
      { autoRefresh: false }
    );
    const outsideCwdReportWithDuplicateRawData = outsideCwdReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string; packageRoot?: string }>;
    };
    expect(outsideCwdReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(outsideCwdReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(outsideCwdReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));
    expect(outsideCwdReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("outside-repo");

    const relativeEscapeReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: "../outside", exitCode: 0, stdoutSummary: "outside ok" }]
      },
      { autoRefresh: false }
    );
    const relativeEscapeReportWithDuplicateRawData = relativeEscapeReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string; packageRoot?: string }>;
    };
    expect(relativeEscapeReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(relativeEscapeReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(relativeEscapeReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));
    expect(relativeEscapeReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("outside-repo");

    const relativeCdEscape = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["cd .. && npm test"] }, { autoRefresh: false });
    const relativeCdEscapeData = relativeCdEscape.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(relativeCdEscapeData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(relativeCdEscapeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const failedReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 1, durationMs: 321, stderrSummary: "vitest failed" }]
      },
      { autoRefresh: false }
    );
    const failedReportData = failedReport.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string; exitCode?: number; outputSummary?: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(failedReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(failedReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command failed with exit code 1", exitCode: 1 })]));
    expect(failedReportData.verificationCoverage.some((entry) => entry.outputSummary?.includes("vitest failed"))).toBe(true);
    expect(failedReportData.outcome.calibrationLabels).toContain("failed-verification-command");

    const failedReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 1, stderrSummary: "vitest failed" }]
      },
      { autoRefresh: false }
    );
    const failedReportWithDuplicateRawData = failedReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
    };
    expect(failedReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(failedReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command failed with exit code 1" })]));
    expect(failedReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const missingExitReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo }]
      },
      { autoRefresh: false }
    );
    const missingExitReportData = missingExitReport.data as {
      driftReasons: string[];
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(missingExitReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingExitReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing exit code" })]));
    expect(missingExitReportData.driftReasons).toContain("recommended tests have not been accounted for");
    expect(missingExitReportData.outcome.calibrationLabels).not.toContain("aggregate-command-coverage");

    const missingExitReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", cwd: repo }]
      },
      { autoRefresh: false }
    );
    const missingExitReportWithDuplicateRawData = missingExitReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ command: string; scopeStatus?: string }>;
    };
    expect(missingExitReportWithDuplicateRawData.testsNotRun).toEqual([]);
    expect(missingExitReportWithDuplicateRawData.commandEnvelopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "npm --silent test", scopeStatus: "repo" }),
        expect.objectContaining({ command: "npm test", scopeStatus: "repo" })
      ])
    );
    expect(missingExitReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing exit code" })]));
    expect(missingExitReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(true);

    const duplicateCommandReports = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          { command: "npm run check", cwd: repo, exitCode: 0, stdoutSummary: "root ok" },
          { command: "npm run check", cwd: path.join(repo, "missing-package"), exitCode: 1, stderrSummary: "nested failed" }
        ]
      },
      { autoRefresh: false }
    );
    const duplicateCommandReportsData = duplicateCommandReports.data as {
      testsNotRun: unknown[];
      verificationCoverage: Array<{ kind: string; source: string; exitCode?: number; outputSummary?: string }>;
    };
    expect(duplicateCommandReportsData.testsNotRun).toEqual([]);
    expect(duplicateCommandReportsData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.exitCode === 0 && entry.outputSummary?.includes("root ok"))).toBe(true);
    expect(duplicateCommandReportsData.verificationCoverage.some((entry) => entry.kind === "unknown" && entry.source === "command failed with exit code 1" && entry.outputSummary?.includes("nested failed"))).toBe(true);

    const distinctSameCommandReports = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          { command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "first run" },
          { command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "second run" }
        ]
      },
      { autoRefresh: false }
    );
    const distinctSameCommandReportsData = distinctSameCommandReports.data as { commandEnvelopes: Array<{ stdoutSummary?: string }> };
    expect(distinctSameCommandReportsData.commandEnvelopes.map((entry) => entry.stdoutSummary)).toEqual(expect.arrayContaining(["first run", "second run"]));
    expect((distinctSameCommandReports.data as { verificationCoverage: Array<{ outputSummary?: string }> }).verificationCoverage.map((entry) => entry.outputSummary)).toEqual(
      expect.arrayContaining([expect.stringContaining("first run"), expect.stringContaining("second run")])
    );

    const rootCdAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`cd ${repo} && npm run check`] }, { autoRefresh: false });
    expect((rootCdAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const envAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["CI=1 npm run check"] }, { autoRefresh: false });
    expect((envAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const envCommandAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["env CI=1 NODE_ENV=test npm run check"] }, { autoRefresh: false });
    expect((envCommandAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const bashWrappedAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ['bash -lc "npm run check"'] }, { autoRefresh: false });
    expect((bashWrappedAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const silentNpmTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm --silent test"] }, { autoRefresh: false });
    expect((silentNpmTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const semanticDuplicateReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", cwd: repo, exitCode: 0, stdoutSummary: "structured silent" }]
      },
      { autoRefresh: false }
    );
    const semanticDuplicateReportData = semanticDuplicateReport.data as { testsNotRun: unknown[]; commandEnvelopes: Array<{ command: string; stdoutSummary?: string }> };
    expect(semanticDuplicateReportData.testsNotRun).toEqual([]);
    expect(semanticDuplicateReportData.commandEnvelopes).toEqual([expect.objectContaining({ command: "npm --silent test", stdoutSummary: "structured silent" })]);

    const malformedSemanticDuplicate = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", exitCode: 0, stdoutSummary: "missing cwd" }]
      },
      { autoRefresh: false }
    );
    const malformedSemanticDuplicateData = malformedSemanticDuplicate.data as {
      testsNotRun: unknown[];
      commandEnvelopes: Array<{ command: string; scopeStatus?: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
    };
    expect(malformedSemanticDuplicateData.testsNotRun).toEqual([]);
    expect(malformedSemanticDuplicateData.commandEnvelopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "npm --silent test", scopeStatus: "missing-cwd" }), expect.objectContaining({ command: "npm test", scopeStatus: "repo" })])
    );
    expect(malformedSemanticDuplicateData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));

    const shortSilentNpmTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm -s test"] }, { autoRefresh: false });
    expect((shortSilentNpmTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const fallbackShellFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["false || npm test"] }, { autoRefresh: false });
    expect((fallbackShellFlow.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const pipedTestOutput = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm test | tee /tmp/codexa-test.log"] }, { autoRefresh: false });
    expect((pipedTestOutput.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const simpleIfFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["if true; then npm test; fi"] }, { autoRefresh: false });
    expect((simpleIfFlow.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const falseIfFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["if false; then npm test; fi"] }, { autoRefresh: false });
    expect((falseIfFlow.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const falseAndFallback = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["false && npm test"] }, { autoRefresh: false });
    expect((falseAndFallback.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const trueOrFallback = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["true || npm test"] }, { autoRefresh: false });
    expect((trueOrFallback.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const cliOutput = execFileSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "post-edit-review",
        repo,
        "--task-id",
        "verification-coverage",
        "--ran-command",
        "npm run check",
        "--ran-command",
        "pytest tests/test_app.py",
        "--no-auto-refresh",
        "--budget",
        "1800"
      ],
      { encoding: "utf8" }
    );
    expect(cliOutput).toContain("Reported ran commands: npm run check | pytest tests/test_app.py");
    expect(cliOutput).toContain("Verification ledger:");

    await changePlanQuery(
      repo,
      {
        task: "Change web widget behavior safely",
        files: ["web/src/widget.ts"],
        changeType: "behavior",
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "verification-web-scope"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "web/src/widget.ts"), "export function widget(value: string) { return value.trim().toUpperCase() }\n", "utf8");
    const rootCheckForWeb = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm run check"] }, { autoRefresh: true });
    const rootCheckData = rootCheckForWeb.data as { testsNotRun: Array<{ path: string }> };
    expect(rootCheckData.testsNotRun.map((test) => test.path)).toContain("web/src/widget.test.ts");

    const spoofedWebScope = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-web-scope",
        ranCommandReports: [{ command: "npm test", cwd: repo, packageManager: "npm", packageRoot: "web", scriptName: "test", args: [], exitCode: 0, stdoutSummary: "claimed web" }]
      },
      { autoRefresh: false }
    );
    const spoofedWebScopeData = spoofedWebScope.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string; scope?: string }>;
    };
    expect(spoofedWebScopeData.testsNotRun.map((test) => test.path)).toContain("web/src/widget.test.ts");
    expect(spoofedWebScopeData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "reported command envelope does not match command text" })]));
    expect(spoofedWebScopeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.scope === "web")).toBe(false);

    const rootTargetedNested = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm run test -- web/src/widget.test.ts"] }, { autoRefresh: false });
    expect((rootTargetedNested.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const rootDirectVitestNested = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["vitest run web/src/widget.test.ts"] }, { autoRefresh: false });
    expect((rootDirectVitestNested.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const envPrefixedNested = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["CI=1 npm run test -- web/src/widget.test.ts"] }, { autoRefresh: false });
    expect((envPrefixedNested.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [`cd ${path.join(repo, "web")} && npm run test`] }, { autoRefresh: false });
    const webCheckData = webCheck.data as { testsNotRun: unknown[]; verificationLedger: Array<{ target: string; status: string }> };
    expect(webCheckData.testsNotRun).toEqual([]);
    expect(webCheckData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const webTargeted = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [`cd ${path.join(repo, "web")} && npm run test -- src/widget.test.ts`] }, { autoRefresh: false });
    const webTargetedData = webTargeted.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(webTargetedData.testsNotRun).toEqual([]);
    expect(webTargetedData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const webPrefixCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm --prefix web test"] }, { autoRefresh: false });
    expect((webPrefixCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webPrefixEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm --prefix=web test"] }, { autoRefresh: false });
    expect((webPrefixEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const pnpmDirCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm --dir web test"] }, { autoRefresh: false });
    expect((pnpmDirCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const pnpmDirEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm --dir=web test"] }, { autoRefresh: false });
    expect((pnpmDirEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webPnpmCwdEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm -C=web test"] }, { autoRefresh: false });
    expect((webPnpmCwdEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webWorkspaceCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm -w web test"] }, { autoRefresh: false });
    expect((webWorkspaceCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webWorkspaceEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm --workspace=web test"] }, { autoRefresh: false });
    expect((webWorkspaceEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webNpmWorkspaceNameCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm -w @acme/widget test"] }, { autoRefresh: false });
    expect((webNpmWorkspaceNameCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webNpmWorkspaceNameEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm --workspace=@acme/widget test"] }, { autoRefresh: false });
    expect((webNpmWorkspaceNameEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const unresolvedNpmWorkspace = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm -w @acme/missing test"] }, { autoRefresh: false });
    const unresolvedNpmWorkspaceData = unresolvedNpmWorkspace.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string; source: string }> };
    expect(unresolvedNpmWorkspaceData.testsNotRun.map((test) => test.path)).toContain("web/src/widget.test.ts");
    expect(unresolvedNpmWorkspaceData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));

    const webYarnCwdCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["yarn --cwd web test"] }, { autoRefresh: false });
    expect((webYarnCwdCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webYarnCwdEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["yarn --cwd=web test"] }, { autoRefresh: false });
    expect((webYarnCwdEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webYarnWorkspaceNameCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["yarn workspace @acme/widget test"] }, { autoRefresh: false });
    expect((webYarnWorkspaceNameCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const repeatedWorkspaceNameCheck = await postEditReviewQuery(
      repo,
      { taskId: "verification-web-scope", ranCommands: ["yarn workspace @acme/widget test", "pnpm --filter @acme/widget test"] },
      { autoRefresh: false }
    );
    const repeatedWorkspaceNameData = repeatedWorkspaceNameCheck.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(repeatedWorkspaceNameData.testsNotRun).toEqual([]);
    expect(repeatedWorkspaceNameData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const webPnpmFilterPathCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm --filter web test"] }, { autoRefresh: false });
    expect((webPnpmFilterPathCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webPnpmFilterNameCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm --filter @acme/widget test"] }, { autoRefresh: false });
    expect((webPnpmFilterNameCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webPnpmFilterEqualsCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["pnpm --filter=@acme/widget test"] }, { autoRefresh: false });
    expect((webPnpmFilterEqualsCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const webSilentPrefixCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm --silent --prefix web test"] }, { autoRefresh: false });
    expect((webSilentPrefixCheck.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    await changePlanQuery(
      repo,
      {
        task: "Change no-script package behavior safely",
        files: ["packages/no-scripts/src/plain.ts"],
        changeType: "behavior",
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "verification-no-scripts"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "packages/no-scripts/src/plain.ts"), "export function plain(value: string) { return value.trim().toUpperCase() }\n", "utf8");
    const noScriptFallback = await postEditReviewQuery(repo, { taskId: "verification-no-scripts", ranCommands: ["cd packages/no-scripts && npm test"] }, { autoRefresh: true });
    expect((noScriptFallback.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("packages/no-scripts/src/plain.test.ts");
  });

  it("emits coverage semantics from test-plan", async () => {
    const repo = await createVerificationCoverageFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toUpperCase() }\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    const data = plan.data as {
      verificationCommands: string[];
      verificationCoverage: Array<{ kind: string; source: string; targetPath?: string; scope?: string }>;
      verificationCommandPlan: Array<{ command: string; covers: string[] }>;
      verificationLedgerPreview: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(plan.text).toContain("If run, these commands would cover:");
    expect(plan.text).toContain("Verification ledger preview if recommended commands are run:");
    expect(data.verificationCommands).toContain("npm run check");
    expect(data.verificationCoverage.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
    const checkCovers = data.verificationCommandPlan.filter((entry) => entry.command.startsWith("npm run check")).flatMap((entry) => entry.covers);
    expect(checkCovers).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
    expect(data.verificationLedgerPreview.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(data.verificationLedgerPreview.find((entry) => entry.target === "tests/shared.test.ts")?.evidence.some((item) => item.includes("npm run check"))).toBe(true);
    const sharedTargetedIndex = data.verificationCommands.findIndex((command) => command.includes("tests/shared.test.ts"));
    const sharedAggregateIndex = data.verificationCommands.findIndex((command) => command === "npm run check");
    expect(sharedTargetedIndex).toBeGreaterThanOrEqual(0);
    expect(sharedAggregateIndex).toBeGreaterThanOrEqual(0);
    expect(sharedTargetedIndex).toBeLessThan(sharedAggregateIndex);
    const sharedTargetedPlanIndex = data.verificationCommandPlan.findIndex((entry) => entry.command.includes("tests/shared.test.ts"));
    const sharedAggregatePlanIndex = data.verificationCommandPlan.findIndex((entry) => entry.command === "npm run check");
    expect(sharedTargetedPlanIndex).toBeGreaterThanOrEqual(0);
    expect(sharedAggregatePlanIndex).toBeGreaterThanOrEqual(0);
    expect(sharedTargetedPlanIndex).toBeLessThan(sharedAggregatePlanIndex);

    await writeFile(path.join(repo, "packages/foo/src/foo.ts"), "export function foo(value: string) { return value.trim().toUpperCase() }\n", "utf8");
    const packagePlan = await testPlanQuery(repo, true, { autoRefresh: true });
    expect((packagePlan.data as { tests: Array<{ path: string; command?: string }> }).tests.find((test) => test.path === "packages/foo/src/foo.test.ts")?.command).toContain(
      `cd ${path.join(repo, "packages/foo")} && npm run test -- src/foo.test.ts`
    );

    for (let index = 0; index < 10; index += 1) {
      const packageRoot = path.join(repo, "packages", `pkg-${index}`);
      await mkdirp(path.join(packageRoot, "src"));
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ scripts: { check: "npm test", test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
      await writeFile(path.join(packageRoot, "src/value.ts"), `export const value${index} = ${index}\n`, "utf8");
      await writeFile(path.join(packageRoot, "src/value.test.ts"), `test('value ${index}', () => expect(${index}).toBe(${index}))\n`, "utf8");
    }
    const latePackageRoot = path.join(repo, "packages", "zz-late");
    await mkdirp(path.join(latePackageRoot, "src"));
    await writeFile(path.join(latePackageRoot, "package.json"), JSON.stringify({ scripts: { check: "npm test", test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
    await writeFile(path.join(latePackageRoot, "src/late.ts"), "export function late(value: string) { return value.trim().toLowerCase() }\n", "utf8");
    await writeFile(path.join(latePackageRoot, "src/late.test.ts"), "import { late } from './late'\ntest('late', () => expect(late(' Z ')).toBe('z'))\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "many packages"], {
      cwd: repo,
      stdio: "ignore"
    });
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(latePackageRoot, "src/late.ts"), "export function late(value: string) { return value.trim().toUpperCase() }\n", "utf8");
    const latePlan = await testPlanQuery(repo, true, { autoRefresh: true });
    const lateCommands = (latePlan.data as { verificationCommands: string[] }).verificationCommands;
    expect(lateCommands.some((command) => command.includes("packages/zz-late") && command.includes("npm run check"))).toBe(true);

    const brief = await taskBriefQuery(repo, { files: ["src/shared.ts"], diff: false, tokenBudget: 2200, limit: 6 }, { autoRefresh: false });
    const briefData = brief.data as {
      verificationCommands: string[];
      verificationCommandPlan: Array<{ command: string; covers: string[] }>;
    };
    expect(brief.text).toContain("If run, these commands would cover:");
    expect(briefData.verificationCommands).toContain("npm run check");
    expect(briefData.verificationCommandPlan.find((entry) => entry.command === "npm run check")?.covers).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));

    await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(path.join(repo, "packages/foo/src/foo.ts"), "export function foo(value: string) { return value.trim().toLowerCase() }\n", "utf8");
    await buildIndex({ repoRoot: repo });
    const pnpmPackagePlan = await testPlanQuery(repo, true, { autoRefresh: true });
    expect((pnpmPackagePlan.data as { tests: Array<{ path: string; command?: string }> }).tests.find((test) => test.path === "packages/foo/src/foo.test.ts")?.command).toContain(
      `cd ${path.join(repo, "packages/foo")} && pnpm run test -- src/foo.test.ts`
    );
  });

  it("rejects malformed expanded task snapshot schemas before post-edit review", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change helper normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "malformed-expanded-schema"
      },
      { autoRefresh: false }
    );

    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/malformed-expanded-schema.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    delete snapshot.plannedEditTargets;
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    const review = await postEditReviewQuery(repo, { taskId: "malformed-expanded-schema", ranTests: [] }, { autoRefresh: false });
    const data = review.data as { snapshot?: unknown; snapshotLoad: { missingReason?: string; error?: string } };
    expect(data.snapshot).toBeUndefined();
    expect(data.snapshotLoad.missingReason).toBe("invalid-json");
    expect(data.snapshotLoad.error).toContain("snapshot schema is invalid");
  });

  it("does not let required dependency checks self-approve from only the edited file", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change isolated helper safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "missing-required-check"
      },
      { autoRefresh: false }
    );
    const snapshotPath = path.join(repo, ".codex/cache/codexa-tasks/missing-required-check.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    snapshot.requiredWorkflowChecks = [];
    snapshot.requiredDependencyChecks = [
      {
        kind: "dependency",
        target: "public-surface: service/helpers.py",
        reason: "regression fixture requires non-edited dependency evidence",
        evidenceTier: "derived",
        confidence: "derived",
        paths: ["service/helpers.py"]
      }
    ];
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip().casefold()\n", "utf8");

    const review = await postEditReviewQuery(repo, { taskId: "missing-required-check", ranTests: ["tests/test_app.py"] }, { autoRefresh: true });
    const reviewData = review.data as {
      verdict: string;
      dependencyChecks: Array<{ target: string; status: string }>;
      driftReasons: string[];
      outcome: { calibrationLabels: string[]; hookSummary: { requiredChecksMissing: number } };
    };
    expect(reviewData.verdict).toBe("inspect");
    expect(reviewData.dependencyChecks).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "public-surface: service/helpers.py", status: "missing" })])
    );
    expect(reviewData.driftReasons).toContain("1 required dependency check(s) missing");
    expect(reviewData.outcome.calibrationLabels).toContain("dependency-checks-missing");
    expect(reviewData.outcome.hookSummary.requiredChecksMissing).toBe(1);

    const legacyWaivedDependency = await postEditReviewQuery(
      repo,
      {
        taskId: "missing-required-check",
        ranTests: ["tests/test_app.py"],
        waivedChecks: ["public-surface: service/helpers.py"]
      },
      { autoRefresh: false }
    );
    const legacyWaivedDependencyData = legacyWaivedDependency.data as {
      dependencyChecks: Array<{ target: string; status: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(legacyWaivedDependencyData.dependencyChecks).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "public-surface: service/helpers.py", status: "missing" })])
    );
    expect(legacyWaivedDependencyData.verificationLedger).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "dependency", target: "public-surface: service/helpers.py", status: "missing" })])
    );
    expect(legacyWaivedDependencyData.outcome.calibrationLabels).toContain("dependency-checks-missing");

    const structuredWaivedDependency = await postEditReviewQuery(
      repo,
      {
        taskId: "missing-required-check",
        ranTests: ["tests/test_app.py"],
        waivers: [{ kind: "dependency", target: "public-surface: service/helpers.py", reason: "manual dependency review" }]
      },
      { autoRefresh: false }
    );
    const structuredWaivedDependencyData = structuredWaivedDependency.data as {
      dependencyChecks: Array<{ target: string; status: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(structuredWaivedDependencyData.dependencyChecks).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "public-surface: service/helpers.py", status: "missing" })])
    );
    expect(structuredWaivedDependencyData.verificationLedger).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "dependency", target: "public-surface: service/helpers.py", status: "waived" })])
    );
    expect(structuredWaivedDependencyData.outcome.calibrationLabels).toContain("dependency-checks-waived");
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

    await buildIndex({ repoRoot: repo });
    const readOnlyBackupDir = path.join(repo, ".codex/.codebase.backup-readonly");
    await rename(codebaseDir, readOnlyBackupDir);
    await mkdir(codebaseDir, { recursive: true });
    await writeFile(path.join(codebaseDir, "index.json"), "{still corrupt", "utf8");
    const readOnlyStatus = await statusQuery(repo, { recover: false });
    expect(readOnlyStatus.freshness.missing).toBe(true);
    expect(await readFile(path.join(codebaseDir, "index.json"), "utf8")).toBe("{still corrupt");
    const recoveredAfterReadOnly = await loadIndex(repo);
    expect(recoveredAfterReadOnly?.files.some((file) => file.path === "src/api.ts")).toBe(true);

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

  it("surfaces TypeScript semantic assist setup failures without aborting indexing", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-bad-tsconfig-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdirp(path.join(repo, "broken/src"));
    await writeFile(path.join(repo, "broken/tsconfig.json"), "{ bad json", "utf8");
    await writeFile(path.join(repo, "broken/src/value.ts"), "export default function brokenDefault() { return 1 }\nexport const value = 1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "bad-tsconfig"], {
      cwd: repo,
      stdio: "ignore"
    });

    const index = await buildIndex({ repoRoot: repo });
    expect(index.files.map((file) => file.path)).toContain("broken/src/value.ts");
    expect(index.symbols.some((symbol) => symbol.path === "broken/src/value.ts" && symbol.name === "value")).toBe(true);
    expect(index.symbols.find((symbol) => symbol.path === "broken/src/value.ts" && symbol.name === "default")?.source).toBe("typescript-syntax");
    expect(index.parserErrors.some((error) => error.path === "broken/tsconfig.json" && error.source === "typescript-compiler")).toBe(true);
  });

  it("does not reuse TypeScript semantic compiler programs across repo roots", async () => {
    const first = await createSemanticDefaultRepo();
    const second = await createSemanticDefaultRepo();

    const firstIndex = await buildIndex({ repoRoot: first });
    const secondIndex = await buildIndex({ repoRoot: second });

    for (const index of [firstIndex, secondIndex]) {
      const defaultSymbol = index.symbols.find((symbol) => symbol.path === "src/local-default.ts" && symbol.name === "default");
      expect(defaultSymbol?.source).toBe("typescript-compiler");
      expect(index.usageSites.some((usage) => usage.path === "src/local-default-consumer.ts" && usage.name === "LocalDefault" && usage.targetSymbolId === defaultSymbol?.id)).toBe(true);
    }
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
    JSON.stringify({ name: "fixture-pkg", exports: { "./feature": "./src/package-entry.ts" }, scripts: { test: "vitest run" }, dependencies: {} }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "src/a"));
  await mkdirp(path.join(repo, "src/b"));
  await mkdirp(path.join(repo, "src/barrel"));
  await mkdirp(path.join(repo, "src/generated"));
  await mkdirp(path.join(repo, "apps/a/src"));
  await mkdirp(path.join(repo, "apps/b/src"));
  await mkdirp(path.join(repo, "web"));
  await mkdirp(path.join(repo, "web/src/lib"));
  await mkdirp(path.join(repo, "sample_api/packages"));
  await mkdirp(path.join(repo, "sample_api/adapters"));
  await mkdirp(path.join(repo, ".codex/static-analysis"));
  await mkdirp(path.join(repo, "reports"));
  await mkdirp(path.join(repo, "service"));
  await mkdirp(path.join(repo, "service/adapters"));
  await mkdirp(path.join(repo, "service/deep"));
  await mkdirp(path.join(repo, "service/models"));
  await mkdirp(path.join(repo, "src/acme"));
  await mkdirp(path.join(repo, "plugins"));
  await mkdirp(path.join(repo, "scripts"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "tests/api"));
  await mkdirp(path.join(repo, "tests/unit"));
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
  await writeFile(path.join(repo, "src/barrel/helper.ts"), "export function nestedHelper() { return 99 }\n", "utf8");
  await writeFile(path.join(repo, "src/barrel-consumer.ts"), "import { helper } from './barrel'\nexport function useBarrelHelper() { return helper() }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default.ts"), "const localDefault = () => 7\nexport { localDefault as default }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default-consumer.ts"), "import LocalDefault from './local-default'\nexport function useLocalDefault() { return LocalDefault() }\n", "utf8");
  await writeFile(path.join(repo, "src/default-barrel.ts"), "export { default as ContractDefault } from './contracts'\nexport type { ThingContract as PublicThingContract } from './contracts'\n", "utf8");
  await writeFile(path.join(repo, "src/default-barrel-consumer.ts"), "import { ContractDefault } from './default-barrel'\nexport function useDefaultAlias() { return ContractDefault() }\n", "utf8");
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
  await writeFile(path.join(repo, "src/instance-service-consumer.ts"), "import { Service } from './service-class'\nexport function runInstance(service: Service) { return service.start() }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client.ts"), "export const client = { get() { return 1 } }\nexport function get() { return 2 }\n", "utf8");
  await writeFile(path.join(repo, "src/object-client-consumer.ts"), "import { client } from './object-client'\nexport function runClient() { return client.get() }\n", "utf8");
  await writeFile(path.join(repo, "src/package-entry.ts"), "export function packageFeature() { return 'package' }\n", "utf8");
  await writeFile(path.join(repo, "src/package-consumer.ts"), "import { packageFeature } from 'fixture-pkg/feature'\nexport function runPackageFeature() { return packageFeature() }\n", "utf8");
  await writeFile(path.join(repo, "apps/a/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2), "utf8");
  await writeFile(path.join(repo, "apps/a/src/lib.ts"), "export function aValue() { return 'a' }\n", "utf8");
  await writeFile(path.join(repo, "apps/a/src/use.ts"), "import { aValue } from '@/lib'\nexport function useA() { return aValue() }\n", "utf8");
  await writeFile(path.join(repo, "apps/b/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2), "utf8");
  await writeFile(path.join(repo, "apps/b/src/lib.ts"), "export function bValue() { return 'b' }\n", "utf8");
  await writeFile(path.join(repo, "apps/b/src/use.ts"), "import { bValue } from '@/lib'\nexport function useB() { return bValue() }\n", "utf8");
  await writeFile(
    path.join(repo, "web/tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } }, references: [{ path: "../src" }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "web/src/lib/thing.ts"), "export function thing() { return 'thing' }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Danger.tsx"), "export function Danger({ html }: { html: string }) { return <div dangerouslySetInnerHTML={{ __html: html }} /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/uses-danger.tsx"), "import { Danger } from './Danger'\nexport function UsesDanger() { return <Danger html=\"ok\" /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/create-element.tsx"), "import React from 'react'\nimport { Danger } from './Danger'\nexport function MakeDanger() { return React.createElement(Danger, { html: 'ok' }) }\n", "utf8");
  await writeFile(path.join(repo, "web/src/DefaultDanger.tsx"), "export { Danger as default } from './Danger'\n", "utf8");
  await writeFile(path.join(repo, "web/src/uses-default-danger.tsx"), "import DangerDefault from './DefaultDanger'\nexport function UsesDefaultDanger() { return <DangerDefault html=\"ok\" /> }\n", "utf8");
  await writeFile(path.join(repo, "web/src/Wrapped.tsx"), "import { memo } from 'react'\nfunction Inner() { return <span /> }\nexport default memo(function WrappedWidget() { return <Inner /> })\n", "utf8");
  await writeFile(
    path.join(repo, "web/src/feature.ts"),
    "import { thing } from '@/lib/thing'\nexport const nodeType = 'media.audio.transform'\nexport function useFeatureThing() { return thing() }\n",
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
    path.join(repo, "sample_api/packages/project.media.json"),
    JSON.stringify({ nodes: [{ type_id: "media.audio.transform", title: "Speech to Speech", adapter_key: "media.audio.transform" }] }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(repo, "sample_api/packages/project.image.json"),
    JSON.stringify({ nodes: [{ type_id: "image.generate", title: "Image Generate", adapter_key: "image.generate" }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, "sample_api/adapters/media.py"), "class MediaAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/image_generate.py"), "class ImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/image.py"), "class ImageAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "sample_api/adapters/generate.py"), "class GenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "service/helpers.py"), "def normalize(value):\n    return value.strip()\n", "utf8");
  await writeFile(path.join(repo, "src/acme/__init__.py"), "__all__ = []\n", "utf8");
  await writeFile(path.join(repo, "src/acme/service.py"), "def src_thing(value):\n    return value\n", "utf8");
  await writeFile(path.join(repo, "plugins/tasks.py"), "def run_plugin():\n    return 'plugin'\n", "utf8");
  await writeFile(path.join(repo, "service/adapters/media.py"), "def dispatch(value):\n    return value\n", "utf8");
  await writeFile(path.join(repo, "service/store.py"), "from .adapters.media import dispatch\n\nclass ProjectStore:\n    def normalize_value(self, value):\n        return dispatch(value)\n", "utf8");
  await writeFile(path.join(repo, "service/__init__.py"), "from .helpers import normalize\n", "utf8");
  await writeFile(path.join(repo, "service/deep/utils.py"), "def clean(value):\n    return value.strip()\n", "utf8");
  await writeFile(path.join(repo, "service/deep/internal.py"), "class Real:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "service/deep/__init__.py"), "from .utils import clean as clean_value\nfrom . import internal\nPublic = internal.Real\n__all__ = ['clean_value', 'Public']\n", "utf8");
  await writeFile(
    path.join(repo, "service/app.py"),
    "from .helpers import normalize\nfrom .store import ProjectStore\n\nstore = ProjectStore()\n\n@router.get('/api/thing')\ndef route_thing(value):\n    store = ProjectStore()\n    return store.normalize_value(normalize(value))\n\n@router.get('/api/global-store')\ndef route_global_store(value):\n    return store.normalize_value(normalize(value))\n\n@router.get('/api' + '/concat')\ndef route_concat(value):\n    return normalize(value)\n\n@router.api_route('/api/items', methods=['GET', 'POST'])\ndef route_items(value):\n    return normalize(value)\n\n@router.get(\n    '/api/multiline'\n)\ndef route_multiline_endpoint(value):\n    return normalize(value)\n\n@router.get('/api/default-fetch')\ndef route_default_get(value):\n    return normalize(value)\n\n@router.post('/api/default-fetch')\ndef route_default_post(value):\n    return normalize(value)\n\n@router.get('/api/query')\ndef route_query(value):\n    return normalize(value)\n\n@app.on_event('startup')\ndef on_startup():\n    return None\n\n@router.post('/async')\nasync def route_async(value):\n    return normalize(value)\n\nclass ThingService:\n    def compute(self, value):\n        return normalize(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/models/app.py"),
    "from service.adapters.media import dispatch\n\n@router.get('/api/model-route')\ndef route_model(value):\n    return dispatch(value)\n",
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
    path.join(repo, "service/deep_user.py"),
    "from service.deep import clean_value\n\ndef route_deep(value):\n    return clean_value(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/star_user.py"),
    "from service.deep import *\n\ndef route_star(value):\n    return clean_value(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/reexport_user.py"),
    "from service.deep import Public\n\ndef route_public():\n    return Public()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/src_layout_user.py"),
    "from acme.service import src_thing\n\ndef route_src_layout(value):\n    return src_thing(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/plugin_user.py"),
    "import plugins.tasks as plugin_tasks\n\ndef route_plugin():\n    return plugin_tasks.run_plugin()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/frameworks.py"),
    "from fastapi import APIRouter, Depends as FastDepends, FastAPI\nfrom pydantic import BaseModel as SchemaBase, Field\nfrom sqlalchemy.orm import DeclarativeBase, mapped_column\nfrom celery import Celery, shared_task\n\napp = FastAPI()\nrouter = APIRouter()\ncelery_app = Celery(__name__)\n\nclass Item(SchemaBase):\n    id: str\n    title: str = Field(default='')\n\nclass Base(DeclarativeBase):\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n    email: str = mapped_column()\n\ndef get_db():\n    return None\n\ndef require_user():\n    return True\n\n@shared_task\ndef rebuild_index_job():\n    return 'ok'\n\n@celery_app.task(name='jobs.rebuild')\ndef rebuild_named_job():\n    return 'ok'\n\ndef schedule_job():\n    celery_app.send_task('jobs.rebuild')\n    return rebuild_named_job.delay()\n\n@router.post('/api/frameworks', dependencies=[FastDepends(require_user)])\ndef create_item(item: Item, db=FastDepends(get_db)):\n    return item\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/framework_sender.py"),
    "import fastapi as fa\nfrom celery import Celery\nfrom service.frameworks import get_db, rebuild_named_job as rebuild_alias\n\nrouter = fa.APIRouter()\ncelery_app = Celery(__name__)\n\n@router.get('/api/framework-sender')\ndef send_framework_task(db=fa.Depends(get_db)):\n    celery_app.send_task('jobs.rebuild')\n    return rebuild_alias.delay()\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_fastapi.py"),
    "def Depends(value):\n    return value\n\ndef local_dep():\n    return None\n\ndef use_local_dep(value=Depends(local_dep)):\n    return value\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_pydantic_model.py"),
    "from pydantic import BaseModel, Field\n\nclass LocalOptions:\n    label: str = Field(default='local')\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_sqlalchemy.py"),
    "def mapped_column(*args, **kwargs):\n    return None\n\nclass Base:\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "service/not_sqlalchemy_import.py"),
    "from sqlalchemy import text\n\ndef mapped_column(*args, **kwargs):\n    return None\n\nclass Base:\n    pass\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = mapped_column(primary_key=True)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'root-client'\n\n@pytest.fixture(autouse=True)\ndef reset_state():\n    return None\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/api/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'api-client'\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/unit/conftest.py"),
    "import pytest\n\n@pytest.fixture\ndef client():\n    return 'unit-client'\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_app.py"),
    "from service.app import route_thing\nimport pytest\n\nclass TestClient:\n    pass\n\n@pytest.fixture\ndef value():\n    return 'A'\n\n@pytest.fixture\ndef derived(value):\n    return value\n\ndef test_route(value):\n    assert route_thing(value) == 'A'\n\ndef test_route_client(client: TestClient):\n    client.get('/api/thing')\n\ndef test_fixture_dependency(derived):\n    assert derived == 'A'\n\nclass TestFixtureScope:\n    @pytest.fixture\n    def scoped_client(self):\n        return 'scoped'\n\n    def test_inside_class_scope(self, scoped_client):\n        assert scoped_client == 'scoped'\n\ndef test_outside_class_scope(scoped_client):\n    assert scoped_client\n",
    "utf8"
  );
  await writeFile(path.join(repo, "tests/api/test_conftest_scope.py"), "def test_api_client(client):\n    assert client == 'api-client'\n", "utf8");
  await writeFile(path.join(repo, "tests/unit/test_conftest_scope.py"), "def test_unit_client(client):\n    assert client == 'unit-client'\n", "utf8");
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

async function createDocFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-doc-fixture-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "docs"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/runtime.ts"), "export function runRuntime() { return 'ok' }\n", "utf8");
  await writeFile(
    path.join(repo, "README.md"),
    "# Runtime Guide\n\nThe runtime guide links to [runtime](src/runtime.ts) and keeps `npm run test` visible.\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "docs/workflow.md"),
    "# Workflow Notes\n\nUse pre edit accountability before changing [`runtime`](../src/runtime.ts). This paragraph mentions pre edit accountability and dirty tree review.\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "doc fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createBroadWorkflowFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-broad-workflow-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "service_noiseflow"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await writeFile(path.join(repo, "service_noiseflow/helpers.py"), "def normalize_noiseflow(value):\n    return value.strip().lower()\n", "utf8");
  await writeFile(
    path.join(repo, "service_noiseflow/app.py"),
    "from .helpers import normalize_noiseflow\n\n@router.post('/noiseflow')\ndef route_noiseflow(value):\n    return normalize_noiseflow(value)\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "tests/test_noiseflow.py"),
    "from service_noiseflow.app import route_noiseflow\n\ndef test_noiseflow_route():\n    assert route_noiseflow(' A ') == 'a'\n",
    "utf8"
  );
  await writeFile(path.join(repo, "src/noiseflow_core.test.ts"), "test('normalize_noiseflow unrelated token noise', () => expect(true).toBe(true))\n", "utf8");
  await writeFile(path.join(repo, "src/noiseflow_feature.ts"), "export const normalize_noiseflow_marker = 'not the route workflow'\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "broad workflow fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  await buildIndex({ repoRoot: repo });
  return repo;
}

async function createVerificationCoverageFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-coverage-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await mkdirp(path.join(repo, "tests"));
  await mkdirp(path.join(repo, "web/src"));
  await mkdirp(path.join(repo, "packages/foo/src"));
  await mkdirp(path.join(repo, "packages/no-scripts/src"));
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        scripts: {
          typecheck: "tsc -p tsconfig.json --noEmit",
          build: "tsc -p tsconfig.json --noEmit",
          lint: "node scripts/lint-placeholder.mjs",
          test: "vitest run",
          check: "npm run typecheck && npm run lint && npm test"
        },
        devDependencies: { vitest: "*" }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }, null, 2), "utf8");
  await mkdirp(path.join(repo, "scripts"));
  await writeFile(path.join(repo, "scripts/lint-placeholder.mjs"), "process.exit(0)\n", "utf8");
  await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "tests/shared.test.ts"), "import { shared } from '../src/shared'\ntest('shared', () => expect(shared(' A ')).toBe('a'))\n", "utf8");
  await writeFile(path.join(repo, "tests/other.test.ts"), "import { shared } from '../src/shared'\ntest('other', () => expect(shared(' B ')).toBe('b'))\n", "utf8");
  await writeFile(path.join(repo, "web/package.json"), JSON.stringify({ name: "@acme/widget", scripts: { test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "web/src/widget.ts"), "export function widget(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "web/src/widget.test.ts"), "import { widget } from './widget'\ntest('widget', () => expect(widget(' C ')).toBe('c'))\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "*" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/foo/src/foo.ts"), "export function foo(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/src/foo.test.ts"), "import { foo } from './foo'\ntest('foo', () => expect(foo(' D ')).toBe('d'))\n", "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/package.json"), JSON.stringify({ name: "no-scripts" }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/src/plain.ts"), "export function plain(value: string) { return value.trim().toLowerCase() }\n", "utf8");
  await writeFile(path.join(repo, "packages/no-scripts/src/plain.test.ts"), "import { plain } from './plain'\ntest('plain', () => expect(plain(' E ')).toBe('e'))\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "verification fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createSemanticDefaultRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-cache-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/local-default.ts"), "const localDefault = () => 7\nexport { localDefault as default }\n", "utf8");
  await writeFile(path.join(repo, "src/local-default-consumer.ts"), "import LocalDefault from './local-default'\nexport function useLocalDefault() { return LocalDefault() }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "semantic-cache"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createManifestGateFixtureRepo(): Promise<string> {
  const repo = await createFixtureRepo();
  await mkdirp(path.join(repo, "docs"));
  await writeFile(
    path.join(repo, "docs/report.json"),
    JSON.stringify(
      {
        nodes: [{ type_id: "fake.node", title: "Fake Node", adapter_key: "fake.adapter" }],
        meta: { note: "nodes and type_id appear here as ordinary content" }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "docs/broken.json"), "{\"notManifest\": true,\n", "utf8");
  await writeFile(
    path.join(repo, "sample_api/packages/project.invalid.json"),
    JSON.stringify(
      {
        nodes: { type_id: "fake.node", title: "Fake Node", adapter_key: "fake.adapter" },
        meta: { note: "schema mismatch should stop indexing" }
      },
      null,
      2
    ),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-manifest-gate-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createDottedReferenceFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-dotted-reference-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/bar.ts"), "export function bar() { return 1 }\n", "utf8");
  await writeFile(path.join(repo, "src/generate.ts"), "export function generate() { return 2 }\n", "utf8");
  await writeFile(
    path.join(repo, "src/reference.ts"),
    "declare const foo: { bar: number }\n// foo.bar should not become a usage site\nexport const reference = foo.bar\nexport const nodeType = 'image.generate'\n",
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-dotted-reference-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createManifestLocalityFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-manifest-locality-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdirp(path.join(repo, "packages/foo/adapters"));
  await mkdirp(path.join(repo, "packages/foo/sub/adapters"));
  await mkdirp(path.join(repo, "packages/bar/adapters"));
  await mkdirp(path.join(repo, "packages/foo"));
  await mkdirp(path.join(repo, "packages/foo/sub"));
  await writeFile(
    path.join(repo, "packages/foo/package.json"),
    JSON.stringify(
      {
        name: "foo",
        nodes: [
          null,
          "not-a-node",
          { type_id: "image.generate", title: "Image Generate", adapter_key: "image.generate" }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(repo, "packages/foo/sub/package.json"),
    JSON.stringify(
      {
        name: "foo-sub",
        nodes: [{ type_id: "image.generate", title: "Nested Image Generate", adapter_key: "image.generate" }]
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(repo, "packages/bar/package.json"), JSON.stringify({ name: "bar" }, null, 2), "utf8");
  await writeFile(path.join(repo, "packages/foo/adapters/image_generate.py"), "class FooImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "packages/foo/sub/adapters/image_generate.py"), "class NestedFooImageGenerateAdapter:\n    pass\n", "utf8");
  await writeFile(path.join(repo, "packages/bar/adapters/image_generate.py"), "class BarImageGenerateAdapter:\n    pass\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "add-manifest-locality-fixtures"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
