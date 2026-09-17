import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndexLocked, getFreshness } from "../src/indexer.js";
import { repoRelativePath } from "../src/git.js";
import { rawSearch } from "../src/query/raw-search.js";
import { verificationCoverageForCommands } from "../src/query/verification.js";
import { resolveIndexLinks } from "../src/resolver.js";
import { isSubpath } from "../src/util.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-review-regression-"));
  roots.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), contents);
  }
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
}

describe("review regressions", () => {
  it("indexes module TypeScript symbols and resolves module-suffixed test imports without duplicate edges", async () => {
    const repo = await fixture({
      "src/value.mts": "export function value() { return 1 }\nexport const second = 2;\n",
      "src/other.cts": "export function other() { return 2 }\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@module": ["./src/value.mjs"], "@common": ["./src/other.cjs"] } } }),
      "tests/aliases.test.ts": "import { value } from '@module';\nimport { other } from '@common';\nvalue(); other();\n",
      "tests/value.test.mts": "import { value, second } from '../src/value.mjs';\nimport { other } from '../src/other.cjs';\nvalue(); other();\n"
    });
    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    expect(index.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["value", "other", "second"]));
    expect(index.imports.map((edge) => edge.resolvedPath)).toEqual(expect.arrayContaining(["src/value.mts", "src/other.cts"]));
    for (const target of ["src/value.mts", "src/other.cts"]) {
      expect(index.testEdges.filter((edge) => edge.path === "tests/value.test.mts" && edge.targetPath === target && edge.reason === `imports ${target}`)).toHaveLength(1);
      expect(index.imports.some((edge) => edge.path === "tests/aliases.test.ts" && edge.resolvedPath === target)).toBe(true);
    }
    expect(resolveIndexLinks(index).testEdges).toEqual(index.testEdges);
  });

  it("detects changes to double-dot-prefixed files while refusing actual parent traversal", async () => {
    const repo = await fixture({ "..state.ts": "export const before = 1;\n" });
    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    await writeFile(path.join(repo, "..state.ts"), "export const after = 2;\n");
    const freshness = await getFreshness(repo, index);
    expect(freshness.stale).toBe(true);
    expect(freshness.dirtyFiles).toContain("..state.ts");
    expect(isSubpath(path.join(repo, "..state.ts"), repo)).toBe(true);
    expect(isSubpath(path.resolve(repo, "../outside.ts"), repo)).toBe(false);
    expect(repoRelativePath("../outside.ts", repo, "")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("preserves colon and newline filenames through ripgrep and git fallback", async () => {
    const names = ["part:one.ts", "part\ntwo.ts"];
    const repo = await fixture(Object.fromEntries(names.map((name) => [name, "export const marker = 'unique_review_literal';\n"])));
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = await mkdtemp(path.join(os.tmpdir(), "codexa-review-bin-"));
    roots.push(bin);
    await symlink(gitPath, path.join(bin, "git"));
    const oldPath = process.env.PATH;
    try {
      for (const searchPath of [oldPath, bin]) {
        process.env.PATH = searchPath;
        const result = await rawSearch(repo, "unique_review_literal", 10);
        expect(result.files.sort()).toEqual(names.sort());
        expect(result.hits.map((hit) => hit.line)).toEqual([1, 1]);
        expect(result.sufficient).toBe(true);
      }
    } finally { process.env.PATH = oldPath; }
  });

  it("rejects inert hygiene arguments while preserving a script that actually executes", async () => {
    const scripts = {
      inert: 'node -e "process.exit(0)" scripts/verify-source-hygiene.mjs scripts/verify-public-hygiene.mjs',
      operand: "node scripts/noop.mjs scripts/verify-source-hygiene.mjs",
      valid: "node --no-warnings scripts/verify-public-hygiene.mjs"
    };
    const repo = await fixture({
      "package.json": JSON.stringify({ name: "fixture", scripts }),
      "scripts/noop.mjs": "process.exit(0);\n",
      "scripts/verify-public-hygiene.mjs": "console.log('checked');\n"
    });
    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    for (const [name, command] of Object.entries(scripts)) {
      const result = spawnSync(command, { cwd: repo, shell: true, encoding: "utf8", timeout: 2000 });
      expect(result.status).toBe(0);
      const coverage = verificationCoverageForCommands(index, [`npm run ${name}`], repo);
      const kinds = coverage.filter((entry) => entry.kind === "lint" || entry.kind === "privacy").map((entry) => entry.kind);
      expect(kinds).toEqual(name === "valid" ? ["privacy"] : []);
      if (name === "valid") expect(result.stdout).toContain("checked");
    }
  });

  it("returns from the malformed TOML hook boundary within an external process deadline", () => {
    const moduleUrl = new URL("../dist/worktree-bootstrap-hook-contract.js", import.meta.url).href;
    const source = `import { inspectHookLaneContract } from ${JSON.stringify(moduleUrl)};
      const result = inspectHookLaneContract('/path/to/project', 'native-windows-mcp', {
        hookInputs: { configContents: Buffer.from('a=[1 #') }
      });
      if (result.ok) process.exit(1);
      console.log('rejected');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 2000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rejected");
    const control = spawnSync(process.execPath, ["--input-type=module", "-e", "import { parse } from 'smol-toml'; if (parse('a=[1,2]').a.length !== 2) process.exit(1);"], { encoding: "utf8", timeout: 2000 });
    expect(control.status).toBe(0);
  });
});
