import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishProjectGithubRelease, sanitizeReleaseRef, writeProjectReleaseNotes } from "../src/github-release.js";

describe("GitHub release timeline", () => {
  it("writes release notes with continue and forward-only revert commands", async () => {
    const repo = await createReleaseRepo("0.2.0", "@example/widget");
    try {
      tag(repo, "v0.1.0", "widget v0.1.0");
      await writeFile(path.join(repo, "src", "index.ts"), "export const value = 2\n", "utf8");
      commitAll(repo, "change value");
      tag(repo, "v0.2.0", "widget v0.2.0");
      const notesFile = path.join(repo, "notes", "v0.2.0.md");

      await writeProjectReleaseNotes(repo, {
        tag: "v0.2.0",
        title: "widget v0.2.0",
        githubRepo: "example-owner/widget",
        notesFile
      });

      const notes = await readFile(notesFile, "utf8");
      expect(notes).toContain("widget release timeline entry for `v0.2.0`.");
      expect(notes).toContain("https://github.com/example-owner/widget/compare/v0.1.0...v0.2.0");
      expect(notes).toContain("## Changelog");
      expect(notes).toContain("### Code and behavior");
      expect(notes).toContain("change value");
      expect(notes).toContain("## Changed Areas");
      expect(notes).toContain("- Code and behavior: `src/index.ts`");
      expect(notes).toContain("## Restore From GitHub");
      expect(notes).toContain("git clone https://github.com/example-owner/widget.git widget-v0.2.0");
      expect(notes).toContain("git switch --detach v0.2.0");
      expect(notes).toContain("## Continue From This Version");
      expect(notes).toContain("git switch -c widget-from-v0.2.0 v0.2.0");
      expect(notes).toContain("git worktree add /path/to/widget-v0.2.0 v0.2.0");
      expect(notes).toContain("## Revert Changes Via PR");
      expect(notes).toContain("git revert --no-commit v0.2.0..HEAD");
      expect(notes).toContain("git push origin revert/widget-v0.2.0");
      expect(notes).not.toContain("codexa-from-");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("groups release notes by changelog category and changed file area", async () => {
    const repo = await createReleaseRepo("0.2.0", "@example/widget");
    try {
      tag(repo, "v0.1.0", "widget v0.1.0");
      await writeFile(path.join(repo, "README.md"), "Release guide\n", "utf8");
      commitAll(repo, "docs: add release guide");
      const docsSha = revParse(repo, "HEAD");
      await mkdir(path.join(repo, "tests"), { recursive: true });
      await writeFile(path.join(repo, "tests", "release.test.ts"), "test('release notes', () => {})\n", "utf8");
      commitAll(repo, "test: cover release notes");
      const testsSha = revParse(repo, "HEAD");
      await writeFile(path.join(repo, "package-lock.json"), "{}\n", "utf8");
      commitAll(repo, "Bump @types/node from 22.19.17 to 25.6.2");
      const dependencySha = revParse(repo, "HEAD");
      tag(repo, "v0.2.0", "widget v0.2.0");
      const notesFile = path.join(repo, "notes", "v0.2.0.md");

      await writeProjectReleaseNotes(repo, {
        tag: "v0.2.0",
        title: "widget v0.2.0",
        githubRepo: "example-owner/widget",
        notesFile
      });

      const notes = await readFile(notesFile, "utf8");
      expect(notes).toContain("### Dependencies and security");
      expect(notes).toContain(`- [${dependencySha.slice(0, 7)}](https://github.com/example-owner/widget/commit/${dependencySha}) Bump @types/node from 22.19.17 to 25.6.2`);
      expect(notes).toContain("### Tests and verification");
      expect(notes).toContain(`- [${testsSha.slice(0, 7)}](https://github.com/example-owner/widget/commit/${testsSha}) test: cover release notes`);
      expect(notes).toContain("### Documentation");
      expect(notes).toContain(`- [${docsSha.slice(0, 7)}](https://github.com/example-owner/widget/commit/${docsSha}) docs: add release guide`);
      expect(notes).toContain("- Dependencies and packaging: `package-lock.json`");
      expect(notes).toContain("- Tests and verification: `tests/release.test.ts`");
      expect(notes).toContain("- Documentation: `README.md`");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("prepares a notes-only release from package version without mutating tags", async () => {
    const repo = await createReleaseRepo("0.3.0", "@example/widget");
    try {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:example-owner/widget.git"], { cwd: repo });
      const notesFile = path.join(repo, "release-notes.md");

      const result = await publishProjectGithubRelease(repo, {
        notesFile,
        githubRelease: false
      });

      expect(result.data.projectName).toBe("widget");
      expect(result.data.projectSlug).toBe("widget");
      expect(result.data.tag).toBe("v0.3.0");
      expect(result.data.githubRepo).toBe("example-owner/widget");
      expect(result.data.releaseUrl).toBe("https://github.com/example-owner/widget/releases/tag/v0.3.0");
      expect(result.data.actions.join("\n")).toContain("would create annotated tag v0.3.0");
      expect(result.data.actions.join("\n")).toContain("stopped after writing notes file");
      const notes = await readFile(notesFile, "utf8");
      expect(notes).toContain("Revert Changes Via PR");
      expect(notes).toContain('git commit -m "Revert widget to v0.3.0"');
      expect(() => execFileSync("git", ["rev-parse", "-q", "--verify", "refs/tags/v0.3.0"], { cwd: repo, stdio: "ignore" })).toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("writes notes without requiring a GitHub remote when push and release creation are disabled", async () => {
    const repo = await createReleaseRepo("0.4.0");
    try {
      const notesFile = path.join(repo, "release-notes.md");

      const result = await publishProjectGithubRelease(repo, {
        notesFile,
        push: false,
        githubRelease: false
      });

      expect(result.data.githubRepo).toBeNull();
      expect(result.data.releaseUrl).toBeNull();
      expect(result.data.actions.join("\n")).toContain("push skipped");
      const notes = await readFile(notesFile, "utf8");
      expect(notes).toContain("Restore From GitHub");
      expect(notes).toContain("Restore from any remote that contains this exact release tag:");
      expect(notes).toContain("git revert --no-commit v0.4.0..HEAD");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns from the checked-out branch even when a target branch is provided", async () => {
    const repo = await createReleaseRepo("0.5.0");
    try {
      execFileSync("git", ["checkout", "-b", "feature/release-draft"], { cwd: repo, stdio: "ignore" });
      const notesFile = path.join(repo, "release-notes.md");

      const result = await publishProjectGithubRelease(repo, {
        notesFile,
        branch: "main",
        push: false,
        githubRelease: false
      });

      expect(result.data.branch).toBe("main");
      expect(result.data.warnings.join("\n")).toContain("current branch is feature/release-draft, not main");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("sanitizes release refs for branch and worktree commands", () => {
    expect(sanitizeReleaseRef("release/v0.2.0 beta")).toBe("release-v0.2.0-beta");
    expect(sanitizeReleaseRef("///")).toBe("release");
  });
});

async function createReleaseRepo(version: string, packageName = "@example/codexa"): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-github-release-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: packageName, version }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "src", "index.ts"), "export const value = 1\n", "utf8");
  commitAll(repo, "fixture");
  return repo;
}

function commitAll(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", message], {
    cwd: repo,
    stdio: "ignore"
  });
}

function tag(repo: string, name: string, message: string): void {
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "tag", "-a", name, "HEAD", "-m", message], {
    cwd: repo,
    stdio: "ignore"
  });
}

function revParse(repo: string, revision: string): string {
  return execFileSync("git", ["rev-parse", revision], { cwd: repo, encoding: "utf8" }).trim();
}
