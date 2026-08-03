import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { verificationLedgerForPostEdit } from "../src/query/verification.js";
import type { CodexaIndex, TestRecommendation, VerificationCommandReport } from "../src/types.js";

describe("Python unittest discovery and node test glob verification credit", () => {
  let repo = "";
  let index: CodexaIndex;
  const tests: TestRecommendation[] = [
    { path: "tests/test_service.py", reason: "Python unit behavior", rank: 10 },
    { path: "tests/test-bad.py", reason: "invalid unittest module name", rank: 9.8 },
    { path: "tests/test.foo.py", reason: "invalid unittest module name", rank: 9.7 },
    { path: "tests/test case.py", reason: "invalid unittest module name", rank: 9.6 },
    { path: "tests/helper_python.py", reason: "non-discovered Python support", rank: 9 },
    { path: "packages/alpha/test/alpha.test.js", reason: "alpha package behavior", rank: 8 },
    { path: "packages/beta/test/beta.test.js", reason: "beta package behavior", rank: 7 },
    { path: "packages/gamma/spec/gamma.test.js", reason: "non-matching package behavior", rank: 6 }
  ];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "codexa-unittest-node-glob-"));
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "verification-fixture", type: "module" }, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "tests/test_service.py"), "import unittest\n\nclass ServiceTest(unittest.TestCase):\n    def test_service(self):\n        self.assertTrue(True)\n", "utf8");
    for (const invalidName of ["test-bad.py", "test.foo.py", "test case.py"]) {
      await writeFile(path.join(repo, "tests", invalidName), "raise RuntimeError('unittest must not import this file')\n", "utf8");
    }
    await writeFile(path.join(repo, "tests/helper_python.py"), "VALUE = True\n", "utf8");
    for (const [name, folder] of [["alpha", "test"], ["beta", "test"], ["gamma", "spec"]] as const) {
      const packageRoot = path.join(repo, "packages", name);
      await mkdir(path.join(packageRoot, folder), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: `@fixture/${name}`, type: "module" }, null, 2)}\n`, "utf8");
      await writeFile(path.join(packageRoot, folder, `${name}.test.js`), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('works', () => assert.equal(1, 1));\n", "utf8");
    }
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "verification fixture"], { cwd: repo, stdio: "ignore" });
    index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("maps successful default unittest discovery to concrete indexed test modules only", () => {
    for (const command of [
      "PYTHONPATH=src python3 -m unittest discover -s tests -v",
      "python -m unittest discover --start-directory=tests --pattern='test*.py' --verbose"
    ]) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.find((entry) => entry.target === "tests/test_service.py"), command).toMatchObject({ status: "covered", trustTier: "reported" });
      expect(result.ledger.find((entry) => entry.target === "tests/helper_python.py"), command).toMatchObject({ status: "missing", trustTier: "none" });
      for (const invalidName of ["test-bad.py", "test.foo.py", "test case.py"]) {
        expect(result.ledger.find((entry) => entry.target === `tests/${invalidName}`), command).toMatchObject({ status: "missing", trustTier: "none" });
      }
      expect(result.coverage.filter((entry) => entry.kind === "python-tests"), command).toMatchObject([
        { targetPath: "tests/test_service.py", scope: "tests" }
      ]);
      expect(result.commandEnvelopes[0].classifierVersion, command).toBe("command-coverage-v6");
    }
  });

  it("expands bounded node --test globs to matching concrete indexed test paths", () => {
    for (const command of [
      "node --test packages/*/test/*.test.js",
      "node --test 'packages/*/test/*.test.js'",
      "node --test 'packages/**/test/*.test.js'"
    ]) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.find((entry) => entry.target === "packages/alpha/test/alpha.test.js"), command).toMatchObject({ status: "covered", trustTier: "reported" });
      expect(result.ledger.find((entry) => entry.target === "packages/beta/test/beta.test.js"), command).toMatchObject({ status: "covered", trustTier: "reported" });
      expect(result.ledger.find((entry) => entry.target === "packages/gamma/spec/gamma.test.js"), command).toMatchObject({ status: "missing", trustTier: "none" });
      const targets = result.coverage.filter((entry) => entry.kind === "javascript-tests").map((entry) => entry.targetPath);
      expect(targets, command).toEqual(["packages/alpha/test/alpha.test.js", "packages/beta/test/beta.test.js"]);
      expect(targets, command).not.toContain("packages/*/test/*.test.js");
    }
  });

  it("fails closed for filtered, ambiguous, missing, or outside unittest discovery scopes", () => {
    const commands = [
      "python3 -m unittest discover -s tests -k service -v",
      "python3 -m unittest discover -s tests -p '*_test.py'",
      "python3 -m unittest discover -s ../tests -v",
      "python3 -m unittest discover -s /tmp/codexa-tests -v",
      "python3 -m unittest discover -s tests --help",
      "python3 -m unittest discover -s",
      "python3 -m unittest tests.test_service",
      "python3 -m unittest discover -s tests --unknown",
      "python3 -m unittest discover -s tests || true"
    ];
    for (const command of commands) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.every((entry) => entry.status === "missing"), command).toBe(true);
      expect(result.coverage.some((entry) => entry.kind === "python-tests"), command).toBe(false);
      expect(result.coverage.some((entry) => entry.kind === "unknown"), command).toBe(true);
    }
  });

  it("fails closed for unsafe, unsupported, unmatched, or filtered node test globs", () => {
    const commands = [
      "node --test '../packages/*/test/*.test.js'",
      "node --test '/tmp/packages/*/test/*.test.js'",
      "node --test 'packages/*/missing/*.test.js'",
      "node --test 'packages/{alpha,beta}/test/*.test.js'",
      "node --test 'packages/alpha/test/alpha?.test.js'",
      `node --test '${"**/".repeat(16)}missing.test.js'`,
      "node --test --test-name-pattern=works 'packages/*/test/*.test.js'"
    ];
    for (const command of commands) {
      const result = classify({ command, cwd: repo, exitCode: 0 });
      expect(result.ledger.every((entry) => entry.status === "missing"), command).toBe(true);
      expect(result.coverage.some((entry) => entry.kind === "javascript-tests" || entry.kind === "targeted-test"), command).toBe(false);
    }
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
