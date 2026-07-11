import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { verificationLedgerForPostEdit } from "../src/query/verification.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import type { CodexaIndex, TestRecommendation, VerificationCommandReport } from "../src/types.js";

describe("Playwright verification credit", () => {
  let repo = "";
  let index: CodexaIndex;
  const tests: TestRecommendation[] = [
    { path: "tests/e2e.spec.ts", reason: "browser behavior", rank: 10 },
    { path: "tests/unit.test.ts", reason: "unit behavior", rank: 9 }
  ];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "codexa-playwright-verification-"));
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify(
        {
          name: "playwright-verification-fixture",
          scripts: {
            e2e: "playwright test tests/e2e.spec.ts",
            "e2e:all": "playwright test",
            test: "vitest run"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(path.join(repo, "tests/e2e.spec.ts"), "export const browserTest = true\n", "utf8");
    await writeFile(path.join(repo, "tests/unit.test.ts"), "export const unitTest = true\n", "utf8");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "playwright verification fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("credits only the explicit Playwright test target across supported launchers", () => {
    const target = "tests/e2e.spec.ts";
    const commands = [
      `playwright test ${target}`,
      `playwright test --project=chromium ${target}`,
      `playwright test --global-timeout=60000 ${target}`,
      `playwright test --repeat-each=2 ${target}`,
      `playwright test --config=playwright.config.ts ${target}`,
      `playwright test ${path.join(repo, target)}`,
      `npx -y playwright test ${target}`,
      `npm exec playwright test ${target}`,
      `pnpm exec playwright test ${target}`,
      `bunx playwright test ${target}`,
      `yarn dlx playwright test ${target}`,
      `npx --package @playwright/test playwright test ${target}`,
      "npm run e2e"
    ];

    for (const command of commands) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.find((entry) => entry.target === target), command).toMatchObject({ status: "covered", trustTier: "reported" });
      expect(result.ledger.find((entry) => entry.target === "tests/unit.test.ts"), command).toMatchObject({ status: "missing", trustTier: "none" });
      expect(result.coverage.some((entry) => entry.kind === "javascript-tests" && entry.targetPath === target), command).toBe(true);
      expect(result.coverage.some((entry) => entry.kind === "targeted-test" && entry.targetPath === target), command).toBe(true);
      expect(result.commandEnvelopes, command).toHaveLength(1);
      expect(result.commandEnvelopes[0].classifierVersion, command).toBe("command-coverage-v4");
    }
    expect(CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion).toBe("command-coverage-v4");
  });

  it("keeps unscoped, non-running, zero-test-tolerant, and unknown Playwright invocations uncredited", () => {
    const commands = [
      "playwright test",
      "playwright test --project=chromium",
      "playwright test --debug tests/e2e.spec.ts",
      "playwright test -g smoke tests/e2e.spec.ts",
      "playwright test --grep=false tests/e2e.spec.ts",
      "playwright test --list tests/e2e.spec.ts",
      "playwright test --ui tests/e2e.spec.ts",
      "playwright test --ui-host=127.0.0.1 tests/e2e.spec.ts",
      "playwright test --ignore-snapshots tests/e2e.spec.ts",
      "playwright test --update-source-method=patch tests/e2e.spec.ts",
      "playwright test --pass-with-no-tests tests/e2e.spec.ts",
      "playwright test --future-flag tests/e2e.spec.ts",
      "playwright test tests/e2e.spec.ts || true",
      "playwright test tests/e2e.spec.ts; true",
      "sh -c 'playwright test tests/e2e.spec.ts || true'",
      "npm run e2e || true",
      "playwright install chromium",
      "playwright show-report",
      "playwright codegen https://example.invalid",
      "npx playwright --help",
      "npm run e2e:all"
    ];

    for (const command of commands) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.every((entry) => entry.status === "missing"), command).toBe(true);
      expect(result.coverage.some((entry) => entry.kind === "javascript-tests" || entry.kind === "targeted-test"), command).toBe(false);
    }
  });

  it("rejects non-running, interactive, mutating, and partial modes for existing JavaScript runners", () => {
    const uncredited = [
      "vitest run --project api",
      "vitest run --project tests/unit.test.ts",
      "vitest run --project=tests/unit.test.ts",
      "vitest list tests/unit.test.ts",
      "vitest bench tests/unit.test.ts",
      "vitest --mergeReports tests/unit.test.ts",
      "vitest --standalone tests/unit.test.ts",
      "vitest --ui tests/unit.test.ts",
      "vitest --watch tests/unit.test.ts",
      "vitest -t smoke tests/unit.test.ts",
      "vitest --testNamePattern=0 tests/unit.test.ts",
      "vitest -u tests/unit.test.ts",
      "vitest --shard=1/2 tests/unit.test.ts",
      "vitest --passWithNoTests tests/unit.test.ts",
      "jest --listTests tests/unit.test.ts",
      "jest --watchAll tests/unit.test.ts",
      "jest -t smoke tests/unit.test.ts",
      "jest --testNamePattern=off tests/unit.test.ts",
      "jest -u tests/unit.test.ts",
      "jest --selectProjects tests/unit.test.ts",
      "jest --passWithNoTests tests/unit.test.ts",
      "node --test --test-name-pattern=smoke tests/unit.test.ts",
      "node --test --test-name-pattern=false tests/unit.test.ts",
      "node --test --test-shard=1/2 tests/unit.test.ts",
      "node --test --test-update-snapshots tests/unit.test.ts"
    ];
    for (const command of uncredited) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.every((entry) => entry.status === "missing"), command).toBe(true);
      expect(result.coverage.some((entry) => entry.kind === "javascript-tests" || entry.kind === "targeted-test"), command).toBe(false);
    }

    const targeted = classify({ command: "vitest run --project api tests/unit.test.ts", cwd: repo, exitCode: 0 });
    expect(targeted.ledger.find((entry) => entry.target === "tests/unit.test.ts")).toMatchObject({ status: "covered", trustTier: "reported" });
    expect(targeted.ledger.find((entry) => entry.target === "tests/e2e.spec.ts")).toMatchObject({ status: "missing", trustTier: "none" });

    const targetShapedProject = classify({ command: "npx -y vitest run --project tests/unit.test.ts tests/e2e.spec.ts", cwd: repo, exitCode: 0 });
    expect(targetShapedProject.ledger.find((entry) => entry.target === "tests/unit.test.ts")).toMatchObject({ status: "missing", trustTier: "none" });
    expect(targetShapedProject.ledger.find((entry) => entry.target === "tests/e2e.spec.ts")).toMatchObject({ status: "covered", trustTier: "reported" });
    expect(targetShapedProject.commandEnvelopes).toMatchObject([
      {
        packageManager: "vitest",
        scriptName: "vitest",
        args: ["run", "--project", "tests/unit.test.ts", "tests/e2e.spec.ts"],
        classifierVersion: "command-coverage-v4"
      }
    ]);

    for (const [command, runner] of [
      ["yarn dlx vitest run tests/unit.test.ts", "vitest"],
      ["yarn exec jest tests/unit.test.ts", "jest"]
    ] as const) {
      const launched = classify({ command, cwd: repo, exitCode: 0 });
      expect(launched.ledger.find((entry) => entry.target === "tests/unit.test.ts"), command).toMatchObject({ status: "covered", trustTier: "reported" });
      expect(launched.commandEnvelopes, command).toMatchObject([{ packageManager: runner, scriptName: runner, classifierVersion: "command-coverage-v4" }]);
    }
  });

  it("keeps structured command envelopes aligned with raw Playwright classification", () => {
    const command = "npx -y playwright test tests/e2e.spec.ts";
    const result = classify({
      command,
      cwd: repo,
      packageManager: "playwright",
      packageRoot: ".",
      scriptName: "playwright",
      args: ["test", "tests/e2e.spec.ts"],
      exitCode: 0
    });
    expect(result.commandEnvelopes).toMatchObject([
      {
        command,
        packageManager: "playwright",
        packageRoot: ".",
        scriptName: "playwright",
        args: ["test", "tests/e2e.spec.ts"],
        source: "reported",
        scopeStatus: "repo",
        classifierVersion: "command-coverage-v4"
      }
    ]);
    expect(result.ledger.find((entry) => entry.target === "tests/e2e.spec.ts")).toMatchObject({ status: "covered", trustTier: "reported" });
  });

  function classify(report: VerificationCommandReport) {
    return verificationLedgerForPostEdit({
      index,
      tests,
      ranTests: [],
      ranCommands: [],
      ranCommandReports: [report],
      repoRoot: repo
    });
  }
});
