import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { createVerificationCoverageFixtureRepo } from "./indexer-fixtures.js";

async function createIndexedVerificationRepo(): Promise<string> {
  const repo = await createVerificationCoverageFixtureRepo();
  await buildIndex({ repoRoot: repo });
  return repo;
}

async function createPlannedSharedChangeRepo(): Promise<string> {
  const repo = await createIndexedVerificationRepo();
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
  return repo;
}

async function createPlannedWebChangeRepo(): Promise<string> {
  const repo = await createIndexedVerificationRepo();
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
  return repo;
}

describe("Codexa verification coverage workspace scopes", () => {
  it("prints the CLI verification ledger for reported commands", async () => {
    const repo = await createPlannedSharedChangeRepo();
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
  });

  it("tracks nested package and workspace test coverage without root over-crediting", async () => {
    const repo = await createPlannedWebChangeRepo();
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

    for (const command of ["npm run test -- web/src/widget.test.ts", "vitest run web/src/widget.test.ts", "CI=1 npm run test -- web/src/widget.test.ts"]) {
      const result = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [command] }, { autoRefresh: false });
      expect((result.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    }

    const webCheck = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [`cd ${path.join(repo, "web")} && npm run test`] }, { autoRefresh: false });
    const webCheckData = webCheck.data as { testsNotRun: unknown[]; verificationLedger: Array<{ target: string; status: string }> };
    expect(webCheckData.testsNotRun).toEqual([]);
    expect(webCheckData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const webTargeted = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [`cd ${path.join(repo, "web")} && npm run test -- src/widget.test.ts`] }, { autoRefresh: false });
    const webTargetedData = webTargeted.data as { testsNotRun: unknown[]; verificationLedger: Array<{ target: string; status: string }> };
    expect(webTargetedData.testsNotRun).toEqual([]);
    expect(webTargetedData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const coveredWorkspaceCommands = [
      "npm --prefix web test",
      "npm --prefix=web test",
      "pnpm --dir web test",
      "pnpm --dir=web test",
      "pnpm -C=web test",
      "npm -w web test",
      "npm --workspace=web test",
      "npm -w @acme/widget test",
      "npm --workspace=@acme/widget test",
      "yarn --cwd web test",
      "yarn --cwd=web test",
      "yarn workspace @acme/widget test",
      "pnpm --filter web test",
      "pnpm --filter @acme/widget test",
      "pnpm --filter=@acme/widget test",
      "npm --silent --prefix web test"
    ];
    for (const command of coveredWorkspaceCommands) {
      const covered = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: [command] }, { autoRefresh: false });
      expect((covered.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    }

    const repeatedWorkspaceNameCheck = await postEditReviewQuery(
      repo,
      { taskId: "verification-web-scope", ranCommands: ["yarn workspace @acme/widget test", "pnpm --filter @acme/widget test"] },
      { autoRefresh: false }
    );
    const repeatedWorkspaceNameData = repeatedWorkspaceNameCheck.data as { testsNotRun: unknown[]; verificationLedger: Array<{ target: string; status: string }> };
    expect(repeatedWorkspaceNameData.testsNotRun).toEqual([]);
    expect(repeatedWorkspaceNameData.verificationLedger.find((entry) => entry.target === "web/src/widget.test.ts")?.status).toBe("covered");

    const unresolvedNpmWorkspace = await postEditReviewQuery(repo, { taskId: "verification-web-scope", ranCommands: ["npm -w @acme/missing test"] }, { autoRefresh: false });
    const unresolvedNpmWorkspaceData = unresolvedNpmWorkspace.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string; source: string }> };
    expect(unresolvedNpmWorkspaceData.testsNotRun.map((test) => test.path)).toContain("web/src/widget.test.ts");
    expect(unresolvedNpmWorkspaceData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));
  });

  it("does not credit no-script package checks as covering package tests", async () => {
    const repo = await createIndexedVerificationRepo();
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
});
