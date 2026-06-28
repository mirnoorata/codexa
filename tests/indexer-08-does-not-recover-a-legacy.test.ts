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
it("does not recover a legacy snapshot over a malformed current blocked marker", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "legacy-only"
      },
      { autoRefresh: false }
    );
    const currentDir = path.join(repo, ".codex/cache/codexa-tasks");
    const legacyDir = path.join(repo, ".codex/cache/codexa-task-snapshots");
    const snapshotText = await readFile(path.join(currentDir, "legacy-only.json"), "utf8");
    const snapshot = JSON.parse(snapshotText) as { createdAt: string };
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "legacy-only.json"), snapshotText, "utf8");
    await writeFile(
      path.join(legacyDir, "latest.json"),
      `${JSON.stringify({ schemaVersion: 1, taskId: "legacy-only", path: "legacy-only.json", createdAt: snapshot.createdAt })}\n`,
      "utf8"
    );
    await rm(path.join(currentDir, "legacy-only.json"), { force: true });
    await changePlanQuery(
      repo,
      {
        task: "Change route normalization safely",
        files: ["service/helpers.py"],
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "current-valid"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(currentDir, "latest.json"), "{not json", "utf8");
    await writeFile(path.join(currentDir, "current-blocked.blocked.json"), "{not json", "utf8");

    const review = await postEditReviewQuery(repo, { ranTests: [], persistOutcome: false }, { autoRefresh: false });
    const reviewData = review.data as { snapshot?: unknown; snapshotLoad: { taskId?: string; missingReason?: string; path?: string } };
    expect(reviewData.snapshot).toBeUndefined();
    expect(reviewData.snapshotLoad).toMatchObject({ taskId: "current-blocked", missingReason: "invalid-json" });
    expect(reviewData.snapshotLoad.path).toContain("current-blocked.blocked.json");
  });

it("emits coverage semantics from test-plan", async () => {
    const repo = await createVerificationCoverageFixtureRepo();
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toUpperCase() }\n", "utf8");

    const plan = await testPlanQuery(repo, true, { autoRefresh: true });
    const data = plan.data as {
      verificationCommands: string[];
      verificationCoverage: Array<{ kind: string; source: string; targetPath?: string; scope?: string }>;
        commandEnvelopes: Array<{ classifierVersion: string; scopeStatus: string }>;
        verificationCommandPlan: Array<{ command: string; covers: string[] }>;
        verificationLedgerPreview: Array<{ target: string; status: string; evidence: string[] }>;
        verificationProvenance: typeof CURRENT_VERIFICATION_PROVENANCE;
        testsNotRun: unknown[];
    };
    expect(plan.text).toContain("If run, these commands would cover:");
    expect(plan.text).toContain("Verification ledger preview if recommended commands are run:");
    expect(data.verificationCommands).toContain("npm run check");
      expect(data.verificationCoverage.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
      expect(data.commandEnvelopes.some((entry) => entry.classifierVersion === CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion && entry.scopeStatus === "repo")).toBe(true);
      expect(data.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect((data.testsNotRun as Array<{ path: string }>).map((test) => test.path)).toContain("tests/shared.test.ts");
    const checkCovers = data.verificationCommandPlan.filter((entry) => entry.command.startsWith("npm run check")).flatMap((entry) => entry.covers);
    expect(checkCovers).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
    expect(data.verificationLedgerPreview.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("would_cover");
    expect(data.verificationLedgerPreview.find((entry) => entry.target === "tests/shared.test.ts")?.evidence.some((item) => item.includes("would cover if run") && item.includes("npm run check"))).toBe(true);
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

      const wrongLanguageAggregate = await postEditReviewQuery(repo, { taskId: "missing-required-check", ranCommands: ["npm test"] }, { autoRefresh: false });
      const wrongLanguageAggregateData = wrongLanguageAggregate.data as {
        dependencyChecks: Array<{ target: string; status: string }>;
        verificationCoverage: Array<{ kind: string }>;
      };
      expect(wrongLanguageAggregateData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(true);
      expect(wrongLanguageAggregateData.dependencyChecks).toEqual(
        expect.arrayContaining([expect.objectContaining({ target: "public-surface: service/helpers.py", status: "missing" })])
      );

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
    expect((review.data as { plannedButUntouchedFiles: string[] }).plannedButUntouchedFiles).not.toContain("src/util.ts");
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
    const noiseDir = path.join(monorepo, "parent-noise");
    await mkdir(noiseDir, { recursive: true });
    const longName = "x".repeat(220);
    for (let batch = 0; batch < 18; batch += 1) {
      await Promise.all(
        Array.from({ length: 250 }, (_, offset) => {
          const index = String(batch * 250 + offset).padStart(4, "0");
          return writeFile(path.join(noiseDir, `${index}-${longName}.txt`), "noise\n", "utf8");
        })
      );
    }
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

it("keeps symbol target candidate ids stable across source-position-only reindexing", async () => {
    const repo = await createFixtureRepo();
    await buildIndex({ repoRoot: repo });
    type TargetCandidate = {
      candidateId: string;
      kind: "file" | "symbol";
      path: string;
      symbol?: { qualifiedName: string; kind: string };
      nextChangePlanArgs: { symbols?: string[] };
    };
    const firstPlan = await changePlanQuery(repo, { task: "Change behavior safely", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    const firstCandidates = ((firstPlan.data as { targetCandidates?: TargetCandidate[] }).targetCandidates ?? []);
    const firstSymbol = firstCandidates.find((candidate) => candidate.kind === "symbol" && candidate.symbol);
    expect(firstSymbol).toBeDefined();

    const original = await readFile(path.join(repo, firstSymbol!.path), "utf8");
    await writeFile(path.join(repo, firstSymbol!.path), `// source-position shift only\n${original}`, "utf8");
    await buildIndex({ repoRoot: repo });

    const shiftedPlan = await changePlanQuery(repo, { task: "Change behavior safely", diff: false, limit: 6, tokenBudget: 1200 }, { autoRefresh: false });
    const shiftedCandidates = ((shiftedPlan.data as { targetCandidates?: TargetCandidate[] }).targetCandidates ?? []);
    const shiftedSymbol = shiftedCandidates.find(
      (candidate) =>
        candidate.kind === "symbol" &&
        candidate.path === firstSymbol!.path &&
        candidate.symbol?.qualifiedName === firstSymbol!.symbol?.qualifiedName &&
        candidate.symbol?.kind === firstSymbol!.symbol?.kind
    );
    expect(shiftedSymbol).toBeDefined();
    expect(shiftedSymbol?.nextChangePlanArgs.symbols?.[0]).not.toBe(firstSymbol?.nextChangePlanArgs.symbols?.[0]);
    expect(shiftedSymbol?.candidateId).toBe(firstSymbol?.candidateId);
  });

it("refuses to build a false fresh index outside git", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codexa-not-git-"));
    await expect(buildIndex({ repoRoot: dir })).rejects.toThrow(/requires a git repository/);
  });
});
