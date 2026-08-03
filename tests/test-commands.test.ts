import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
import { candidateTestCommand } from "../src/query/test-commands.js";
import { verificationCoverageForCommands } from "../src/query/verification.js";

const execFile = promisify(execFileCallback);

describe("candidate test commands", () => {
  it("does not append a test path to a compile-only TypeScript script", async () => {
    const repo = await packageFixture({ test: "tsc --noEmit" });

    const candidate = candidateTestCommand(repo, "tests/example.test.ts");

    expect(candidate?.commandArgs).toEqual(["run", "test"]);
    expect(candidate?.command).not.toContain("tests/example.test.ts");
  });

  it("passes a test path to a target-aware runner", async () => {
    const repo = await packageFixture({ test: "vitest run" });

    const candidate = candidateTestCommand(repo, "tests/example.test.ts");

    expect(candidate?.commandArgs).toEqual(["run", "test", "--", "tests/example.test.ts"]);
    expect(candidate?.command).toContain("tests/example.test.ts");
  });

  it("uses Cypress's --spec selector instead of a bare positional path", async () => {
    const repo = await packageFixture({ test: "cypress run" });

    const candidate = candidateTestCommand(repo, "tests/example.test.ts");

    expect(candidate?.commandArgs).toEqual([
      "run",
      "test",
      "--",
      "--spec",
      "tests/example.test.ts"
    ]);
    expect(candidate?.command).toContain("-- --spec tests/example.test.ts");

    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: false });
    const coverage = verificationCoverageForCommands(index, [candidate?.command ?? ""], repo);
    expect(coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "javascript-tests", targetPath: "tests/example.test.ts" }),
        expect.objectContaining({ kind: "targeted-test", targetPath: "tests/example.test.ts" })
      ])
    );
  });

  it("recognizes conventional Cypress .cy test names", async () => {
    const repo = await packageFixture({ test: "cypress run" });

    const candidate = candidateTestCommand(repo, "cypress/e2e/login.cy.ts");

    expect(candidate?.commandArgs).toEqual([
      "run",
      "test",
      "--",
      "--spec",
      "cypress/e2e/login.cy.ts"
    ]);
    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: false });
    expect(index.files.find((file) => file.path === "cypress/e2e/login.cy.ts")?.test).toBe(true);
    const coverage = verificationCoverageForCommands(index, [candidate?.command ?? ""], repo);
    expect(coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "javascript-tests", targetPath: "cypress/e2e/login.cy.ts" }),
        expect.objectContaining({ kind: "targeted-test", targetPath: "cypress/e2e/login.cy.ts" })
      ])
    );
  });

  it("does not forward a selector into a compound script's trailing command", async () => {
    const repo = await packageFixture({ test: "echo vitest run && printf FINAL:%s\\n" });

    const candidate = candidateTestCommand(repo, "tests/example.test.ts");

    expect(candidate?.commandArgs).toEqual(["run", "test"]);
    expect(candidate?.command).not.toContain("tests/example.test.ts");
  });
});

async function packageFixture(scripts: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-test-command-"));
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await mkdir(path.join(repo, "cypress/e2e"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "tests/example.test.ts"), "export {};\n", "utf8");
  await writeFile(path.join(repo, "cypress/e2e/login.cy.ts"), "export {};\n", "utf8");
  await execFile("git", ["init", "-q"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "Codexa Test"], { cwd: repo });
  await execFile("git", ["add", "."], { cwd: repo });
  await execFile("git", ["commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}
