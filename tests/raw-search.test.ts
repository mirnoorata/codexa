import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baselineSearchSummary, rawSearch } from "../src/query/raw-search.js";

describe("raw search fallback", () => {
  it("searches multiple literal patterns in one pass", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-raw-search-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/pascal.ts"), "export const CodexaMultiLiteral = 1\n", "utf8");
    await writeFile(path.join(repo, "src/snake.ts"), "export const marker = 'codexa_multi_snake_literal'\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const result = await rawSearch(repo, ["CodexaMultiLiteral", "codexa_multi_snake_literal"], 10);
    expect(result.patterns).toEqual(["CodexaMultiLiteral", "codexa_multi_snake_literal"]);
    expect(result.command).toContain("-e");
    expect(result.files).toEqual(["src/pascal.ts", "src/snake.ts"]);
    expect(result.hits.map((hit) => hit.pattern)).toEqual(expect.arrayContaining(["CodexaMultiLiteral", "codexa_multi_snake_literal"]));
  });

  it("rejects raw searches that exceed the shared pattern cap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-raw-search-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });

    await expect(
      rawSearch(
        repo,
        Array.from({ length: 9 }, (_, index) => `codexa-pattern-${index}`),
        5
      )
    ).rejects.toThrow("Raw search supports at most 8 literal patterns");
  });

  it("uses git grep when ripgrep is unavailable", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-raw-search-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/index.ts"), "export const marker = 'codexa_raw_search_fallback_literal'\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });

    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-raw-search-bin-"));
    await symlink(gitPath, path.join(binDir, "git"));

    const oldPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const result = await rawSearch(repo, "codexa_raw_search_fallback_literal", 5);
      expect(result.command).toContain("git grep");
      expect(result.command).toContain("fallback");
      expect(result.sufficient).toBe(true);
      expect(result.files).toEqual(["src/index.ts"]);

      const summary = await baselineSearchSummary(repo, "codexa_raw_search_fallback_literal");
      expect(summary?.command).toContain("git grep");
      expect(summary?.lines).toBe(1);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
