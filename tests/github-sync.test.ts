import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGithubSyncNextSteps, buildGithubSyncWarnings, checkGithubSync, parseGithubRemote } from "../src/github-sync.js";

describe("GitHub sync diagnostics", () => {
  it("parses common GitHub remote URL forms", () => {
    expect(parseGithubRemote("https://github.com/mirnoorata/codexa.git")).toBe("mirnoorata/codexa");
    expect(parseGithubRemote("https://token@github.com/mirnoorata/codexa")).toBe("mirnoorata/codexa");
    expect(parseGithubRemote("git@github.com:mirnoorata/codexa.git")).toBe("mirnoorata/codexa");
    expect(parseGithubRemote("ssh://git@github.com/mirnoorata/codexa.git")).toBe("mirnoorata/codexa");
    expect(parseGithubRemote("https://example.com/mirnoorata/codexa.git")).toBeNull();
  });

  it("reports a deterministic no-network source sync plan for a GitHub repo", async () => {
    const repo = await createGitRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/mirnoorata/codexa.git"], { cwd: repo });

    const result = await checkGithubSync(repo, {
      skipNetwork: true,
      checkGh: false
    });

    expect(result.data.repoRoot).toBe(repo);
    expect(result.data.branch).toBe("main");
    expect(result.data.repoFullName).toBe("mirnoorata/codexa");
    expect(result.data.remoteChecked).toBe(false);
    expect(result.data.pushDryRunChecked).toBe(false);
    expect(result.data.nextSteps.join("\n")).toContain("push --dry-run");
    expect(result.text).toContain("GitHub sync check");
    expect(result.text).toContain("do not use GitHub Packages for source sync");
  });

  it("warns when a repository has no GitHub remote", async () => {
    const repo = await createGitRepo();

    const result = await checkGithubSync(repo, {
      skipNetwork: true,
      checkGh: false
    });

    expect(result.data.remoteUrl).toBeNull();
    expect(result.data.warnings).toContain("no origin remote URL is configured");
    expect(result.data.nextSteps[0]).toContain("remote add origin");
  });

  it("does not recommend pushing when the remote head already matches local head", async () => {
    const nextSteps = buildGithubSyncNextSteps({
      repoRoot: "/srv/codexa",
      branch: "main",
      remoteName: "origin",
      remoteUrl: "git@github.com:mirnoorata/codexa.git",
      repoFullName: "mirnoorata/codexa",
      localHead: "876ddf19ea32e5ceb7f852f36121a6e6d11a83e1",
      remoteHead: "876ddf19ea32e5ceb7f852f36121a6e6d11a83e1",
      pushDryRunChecked: true,
      pushDryRunOk: true,
      authBlocked: false,
      ghInstalled: true,
      ghAuthenticated: true
    });

    expect(nextSteps[0]).toContain("already synced");
    expect(nextSteps.join("\n")).not.toContain("push the current branch");
  });

  it("treats logged-out gh as acceptable when SSH source sync is already healthy", async () => {
    const result = await checkGithubSync(await createGitRepoWithSshRemote(), {
      skipNetwork: true,
      checkGh: false
    });
    const warnings = buildGithubSyncWarnings({
      branch: result.data.branch,
      dirtyFileCount: result.data.dirtyFileCount,
      localHead: result.data.localHead,
      remoteUrl: result.data.remoteUrl,
      repoFullName: result.data.repoFullName,
      remoteHead: result.data.localHead,
      remoteChecked: true,
      pushDryRunChecked: true,
      pushDryRunOk: true,
      ghInstalled: true,
      ghAuthenticated: false,
      authBlocked: false
    });
    const nextSteps = buildGithubSyncNextSteps({
      repoRoot: result.data.repoRoot,
      branch: result.data.branch,
      remoteName: result.data.remoteName,
      remoteUrl: result.data.remoteUrl,
      repoFullName: result.data.repoFullName,
      localHead: result.data.localHead,
      remoteHead: result.data.localHead,
      pushDryRunChecked: true,
      pushDryRunOk: true,
      authBlocked: false,
      ghInstalled: true,
      ghAuthenticated: false
    });

    expect(warnings).not.toContain("GitHub CLI is installed but not authenticated for github.com");
    expect(nextSteps.join("\n")).toContain("keep gh logged out");
  });

  it("does not convert logged-out gh into a source git auth warning", () => {
    const warnings = buildGithubSyncWarnings({
      branch: "main",
      dirtyFileCount: 0,
      localHead: "69ce4b6a95dae12815f4070a7974b0a7bc37c972",
      remoteUrl: "git@github.com:mirnoorata/codexa.git",
      repoFullName: "mirnoorata/codexa",
      remoteHead: "69ce4b6a95dae12815f4070a7974b0a7bc37c972",
      remoteChecked: true,
      pushDryRunChecked: true,
      pushDryRunOk: true,
      ghInstalled: true,
      ghAuthenticated: false,
      authBlocked: false
    });

    expect(warnings).toEqual([]);
  });
});

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-github-sync-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}

async function createGitRepoWithSshRemote(): Promise<string> {
  const repo = await createGitRepo();
  execFileSync("git", ["remote", "add", "origin", "git@github.com:mirnoorata/codexa.git"], { cwd: repo });
  return repo;
}
