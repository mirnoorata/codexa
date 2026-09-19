import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { candidateTestCommand } from "../src/query/test-commands.js";
import { verificationLedgerForPostEdit } from "../src/query/verification.js";
import type { CodexaIndex } from "../src/types.js";

describe("conservative Go package verification", () => {
  let repo: string;
  let index: CodexaIndex;
  const ordinaryNames = ["linux_test.go", "client_linux_helpers_test.go", "amd64_test.go", "client_amd64_helpers_test.go"];
  const constrainedNames = ["client_linux_test.go", "client_amd64_test.go", "client_linux_amd64_test.go"];
  const ordinaryPaths = ordinaryNames.map(name => `filenames/${name}`);
  const paths = ["root_test.go", "pkg/value_test.go", "pkg/conditional_test.go", "pkg/value_windows_test.go", "nested/nested_test.go", "testdata/hidden_test.go", "empty/helper_test.go", "bypass/bypass_test.go", ...ordinaryPaths, ...constrainedNames.map(name => `filenames/${name}`)];
  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "codexa-go-verification-"));
    await writeFile(path.join(repo, "go.mod"), "module example.com/fixture\n\ngo 1.20\n");
    for (const filename of paths) {
      await mkdir(path.dirname(path.join(repo, filename)), { recursive: true });
      const header = filename.includes("conditional") ? "//go:build never_enabled\n\n" : "";
      const testName = filename.startsWith("filenames/") ? `Test_${path.basename(filename).replaceAll(".", "_")}` : "TestValue";
      await writeFile(path.join(repo, filename), header + `package fixture\nimport "testing"\nfunc ${testName}(t *testing.T) { if 1 + 1 != 2 { t.Fatal("value") } }\n`);
    }
    await writeFile(path.join(repo, "nested/go.mod"), "module example.com/nested\n\ngo 1.20\n");
    await writeFile(path.join(repo, "empty/helper_test.go"), "package fixture\nfunc helper() {}\n");
    await writeFile(path.join(repo, "bypass/bypass_test.go"), 'package fixture\nimport "testing"\nfunc TestMain(m *testing.M) {}\nfunc TestValue(t *testing.T) { t.Fatal("not actually run") }\n');
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });
  function classify(command: string, cwd = repo, exitCode = 0) {
    return verificationLedgerForPostEdit({ index, tests: paths.map(path => ({ path, rank: 1, reason: "fixture" })), ranTests: [], ranCommands: [], ranCommandReports: [{ command, cwd, exitCode }], repoRoot: repo });
  }
  const covered = (result: ReturnType<typeof classify>) => result.ledger.filter(entry => entry.status === "covered").map(entry => entry.target);

  it("scopes package lists, cwd and recursive tests without crossing module or build constraints", () => {
    expect(covered(classify("go test -count=1 ./..."))).toEqual(["root_test.go", "pkg/value_test.go", ...ordinaryPaths]);
    expect(covered(classify("go test"))).toEqual(["root_test.go"]);
    expect(covered(classify("go test -v ./pkg"))).toEqual(["pkg/value_test.go"]);
    expect(covered(classify("go test .", path.join(repo, "nested")))).toEqual(["nested/nested_test.go"]);
    expect(covered(classify("cd pkg && go test -count 1 ."))).toEqual(["pkg/value_test.go"]);
    expect(covered(classify("sh -c 'go test ./pkg'"))).toEqual(["pkg/value_test.go"]);
    expect(classify("go test ./...").ledger[0].trustTier).toBe("reported");
  });

  it("recognizes only platform suffixes, not OS or architecture words elsewhere in a filename", () => {
    expect(covered(classify("go test ./filenames"))).toEqual(ordinaryPaths);
  });

  it.each([
    "go test -c ./pkg", "go test -list . ./pkg", "go test -run TestValue ./pkg", "go test -run '^$' ./pkg",
    "go test -count=0 ./pkg", "go test -short ./pkg", "go test -tags=never_enabled ./pkg", "go test -args -test.run=^$",
    "go test ./pkg || true", "go test ./pkg | cat", "go test ./pkg; true", "go test ./pkg &",
    "go test ./pkg/value_test.go", "go test ../outside", "go test example.com/elsewhere", "go test ./pkg --unknown",
    "GOFLAGS='-run=^$' go test ./pkg", "go test ./empty", "go test ./bypass", "go test -count", "go test -count=bad"
  ])("does not credit unsupported or non-running command %s", command => {
    expect(covered(classify(command))).toEqual([]);
  });

  it("does not promote failed, outside, or mismatched reported execution", () => {
    expect(covered(classify("go test ./...", repo, 1))).toEqual([]);
    expect(covered(classify("go test ./...", path.dirname(repo)))).toEqual([]);
  });

  it.skipIf(spawnSync("go", ["version"]).status !== 0)("matches actual Go execution and recommends a runnable package command", () => {
    const command = candidateTestCommand(repo, "pkg/value_test.go")!;
    expect(command).toMatchObject({ commandExecutable: "go", commandArgs: ["test", "-count=1", "."], commandCwd: path.join(repo, "pkg") });
    const output = execFileSync("go", ["test", "-count=1", "-v", "./..."], { cwd: repo, encoding: "utf8", env: { ...process.env, GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local", GOPROXY: "off" }, timeout: 60_000 });
    expect(output).toContain("--- PASS: TestValue");
    expect(output).not.toContain("example.com/nested");
    const packageInfo = JSON.parse(execFileSync("go", ["list", "-json", "./filenames"], { cwd: repo, encoding: "utf8", env: { ...process.env, GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local", GOPROXY: "off" }, timeout: 60_000 }));
    expect(packageInfo.TestGoFiles).toEqual(expect.arrayContaining(ordinaryNames));
    expect(covered(classify(command.command))).toEqual(["pkg/value_test.go"]);
  }, 65_000);
});
