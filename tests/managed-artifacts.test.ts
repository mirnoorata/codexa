import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { readManagedArtifactText } from "../src/managed-artifacts.js";

const temporaryRoots: string[] = [];
const itPosix = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed index artifact boundaries", () => {
  itPosix("rejects a symlinked .codex directory without mutating its external target", async () => {
    const repo = await createRepo("codexa-index-boundary-root-");
    const outside = await temporaryRoot("codexa-index-boundary-root-target-");
    const externalCodebase = path.join(outside, "codebase");
    await mkdir(externalCodebase);
    const sentinel = path.join(externalCodebase, "sentinel.txt");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await symlink(outside, path.join(repo, ".codex"), "dir");

    await expect(buildIndex({ repoRoot: repo })).rejects.toThrow(/managed state|symbolic link|redirected/u);

    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
    expect(await readdir(externalCodebase)).toEqual(["sentinel.txt"]);
  });

  itPosix("rejects a symlinked codebase directory without deleting external contents", async () => {
    const repo = await createRepo("codexa-index-boundary-codebase-");
    const outside = await temporaryRoot("codexa-index-boundary-codebase-target-");
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await mkdir(path.join(repo, ".codex"));
    await symlink(outside, path.join(repo, ".codex", "codebase"), "dir");

    await expect(buildIndex({ repoRoot: repo })).rejects.toThrow(/managed artifact|symbolic link/u);

    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
    expect((await readdir(outside)).sort()).toEqual(["sentinel.txt"]);
  });

  itPosix("rejects a symlinked parse-cache directory before reading or writing its target", async () => {
    const repo = await createRepo("codexa-index-boundary-cache-");
    const outside = await temporaryRoot("codexa-index-boundary-cache-target-");
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await mkdir(path.join(repo, ".codex"));
    await symlink(outside, path.join(repo, ".codex", "cache"), "dir");

    await expect(buildIndex({ repoRoot: repo })).rejects.toThrow(/managed state|redirected/u);

    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
    expect((await readdir(outside)).sort()).toEqual(["sentinel.txt"]);
  });

  it("rejects a custom output directory before creating anything at that target", async () => {
    const repo = await createRepo("codexa-index-boundary-output-");
    const outside = await temporaryRoot("codexa-index-boundary-output-target-");
    const outputDir = path.join(outside, "published-index");

    await expect(buildIndex({ repoRoot: repo, outputDir })).rejects.toThrow(/managed repository path/u);

    await expect(readdir(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("preserves indexing through a symlink alias of the repository root", async () => {
    const repo = await createRepo("codexa-index-boundary-alias-");
    const alias = `${repo}-alias`;
    await symlink(repo, alias, "dir");
    try {
      const index = await buildIndex({ repoRoot: alias });

      expect(index.snapshot.repoRoot).toBe(path.resolve(alias));
      expect(await readFile(path.join(repo, ".codex", "codebase", "README.md"), "utf8")).toContain(
        "# Codexa Codebase Context"
      );
    } finally {
      await rm(alias, { force: true });
    }
  });

  itPosix("replaces a redirected parse-cache leaf without mutating its target", async () => {
    const repo = await createRepo("codexa-index-boundary-cache-leaf-");
    const outside = await temporaryRoot("codexa-index-boundary-cache-leaf-target-");
    await buildIndex({ repoRoot: repo });
    const cachePath = path.join(repo, ".codex", "cache", "codexa-parse-cache.json");
    const sentinel = path.join(outside, "sentinel.json");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await rm(cachePath);
    await symlink(sentinel, cachePath);

    await buildIndex({ repoRoot: repo });

    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
    expect((await lstat(cachePath)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ version: expect.any(String) });
  });

  itPosix("does not import parse facts through a symlinked cache during read-only indexing", async () => {
    const repo = await createRepo("codexa-index-boundary-cache-poison-");
    const outside = await temporaryRoot("codexa-index-boundary-cache-poison-target-");
    await buildIndex({ repoRoot: repo });
    const cacheDir = path.join(repo, ".codex", "cache");
    const cache = JSON.parse(await readFile(path.join(cacheDir, "codexa-parse-cache.json"), "utf8")) as {
      entries: Record<string, { result: { symbols: Array<{ name: string; qualifiedName: string }> } }>;
    };
    const cachedSymbol = cache.entries["src/index.ts"]?.result.symbols[0];
    expect(cachedSymbol).toBeDefined();
    cachedSymbol!.name = "EXTERNAL_POISON";
    cachedSymbol!.qualifiedName = "EXTERNAL_POISON";
    await writeFile(path.join(outside, "codexa-parse-cache.json"), `${JSON.stringify(cache)}\n`, "utf8");
    await rm(cacheDir, { recursive: true });
    await symlink(outside, cacheDir, "dir");

    const index = await buildIndex({ repoRoot: repo, writeArtifacts: false });

    expect(index.symbols.some((symbol) => symbol.name === "EXTERNAL_POISON")).toBe(false);
  });

  it("does not import or overwrite forged parse facts from a force-tracked cache", async () => {
    const repo = await createRepo("codexa-index-boundary-tracked-cache-");
    await buildIndex({ repoRoot: repo });
    const cachePath = path.join(repo, ".codex", "cache", "codexa-parse-cache.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Record<string, { result: { symbols: Array<{ name: string; qualifiedName: string }> } }>;
    };
    const cachedSymbol = cache.entries["src/index.ts"]?.result.symbols[0];
    expect(cachedSymbol).toBeDefined();
    cachedSymbol!.name = "TRACKED_CACHE_POISON";
    cachedSymbol!.qualifiedName = "TRACKED_CACHE_POISON";
    const poison = `${JSON.stringify(cache)}\n`;
    await writeFile(cachePath, poison, "utf8");
    execFileSync("git", ["add", "-f", ".codex/cache/codexa-parse-cache.json"], {
      cwd: repo,
      stdio: "ignore"
    });

    const readOnlyIndex = await buildIndex({ repoRoot: repo, writeArtifacts: false });
    const normalIndex = await buildIndex({ repoRoot: repo });

    expect(readOnlyIndex.symbols.some((symbol) => symbol.name === "TRACKED_CACHE_POISON")).toBe(false);
    expect(normalIndex.symbols.some((symbol) => symbol.name === "TRACKED_CACHE_POISON")).toBe(false);
    expect(await readFile(cachePath, "utf8")).toBe(poison);
  });

  itPosix("refuses hardlinked and broken-symlink artifact leaves", async () => {
    const repo = await createRepo("codexa-index-boundary-leaf-");
    const outside = await temporaryRoot("codexa-index-boundary-leaf-target-");
    await buildIndex({ repoRoot: repo });
    const modules = path.join(repo, ".codex", "codebase", "modules");
    const sentinel = path.join(outside, "sentinel.md");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await link(sentinel, path.join(modules, "hardlinked.md"));
    await symlink(path.join(outside, "missing.md"), path.join(modules, "broken.md"));

    await expect(
      readManagedArtifactText(repo, [".codex", "codebase", "modules", "hardlinked.md"])
    ).rejects.toThrow(/redirected|non-regular/u);
    await expect(
      readManagedArtifactText(repo, [".codex", "codebase", "modules", "broken.md"])
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
  });

  it("rejects Windows stream, device, wildcard, control, and trailing-dot path segments portably", async () => {
    const repo = await createRepo("codexa-index-boundary-portable-name-");
    const invalidNames = [
      "module.md:secret.md",
      "C:module.md",
      "con.md",
      "LPT9.txt",
      "wild?.md",
      "quote\".md",
      "control\u0001.md",
      "trailing.md."
    ];

    for (const name of invalidNames) {
      await expect(
        readManagedArtifactText(repo, [".codex", "codebase", "modules", name]),
        name
      ).rejects.toThrow(/Invalid Codexa managed artifact path segment/u);
    }
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await temporaryRoot(prefix);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "index.ts"), "export const value = 1\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
