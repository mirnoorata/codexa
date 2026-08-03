import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeArtifacts } from "../src/artifacts.js";
import { moduleArtifactFileName } from "../src/module-artifact-name.js";
import { targetPlaybookHints } from "../src/skill-hints.js";
import type { CodexaIndex, ModuleClusterFact } from "../src/types.js";

const INDEXED_AT = "2026-01-02T03:04:05.000Z";
const SNAPSHOT_ID = "artifact-filename-snapshot";
const itPosix = process.platform === "win32" ? it.skip : it;

describe("module artifact filenames", () => {
  it("keeps lossy slugs and case-only names collision-safe and deterministic", () => {
    const modules = collisionModules();
    const first = modules.map(moduleArtifactFileName);
    const second = modules.map((module) => moduleArtifactFileName({ ...module }));

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(modules.length);
    expect(new Set(first.map((name) => name.toLowerCase())).size).toBe(modules.length);
    expect(first.map(readableStem)).toEqual(["web-foo", "web-foo", "billing", "billing"]);
    expect(first.every((name) => /^[a-z0-9][a-z0-9._-]*-[a-f0-9]{16}\.md$/u.test(name))).toBe(true);

    const sameLabelPath = moduleFact("same-id", "shared", "shared/path.ts", "path");
    const sameLabelFunctional = moduleFact("same-id", "shared", "shared/functional.ts", "functional");
    expect(moduleArtifactFileName(sameLabelPath)).not.toBe(moduleArtifactFileName(sameLabelFunctional));

    const longName = moduleArtifactFileName(moduleFact("long-id", `${"nested/".repeat(100)}module`, "long.ts", "path"));
    expect(longName.length).toBeLessThanOrEqual(84);
    expect(longName).not.toMatch(/[\\/]/u);
  });

  it("uses the identity filename for artifact writes, playbook links, and target hints", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-filenames-"));
    const outputDir = path.join(repoRoot, ".codex/codebase");
    const modules = collisionModules();
    const index = minimalIndex(repoRoot, modules);
    const expectedNames = modules.map(moduleArtifactFileName).sort();

    try {
      await writeArtifacts(index, outputDir);

      expect((await readdir(path.join(outputDir, "modules"))).sort()).toEqual(expectedNames);
      expect((await readdir(path.join(outputDir, "playbooks"))).filter((name) => name !== "README.md").sort()).toEqual(expectedNames);

      const playbookIndex = await readFile(path.join(outputDir, "playbooks/README.md"), "utf8");
      for (const module of modules) {
        const fileName = moduleArtifactFileName(module);
        expect(playbookIndex).toContain(`playbooks/${fileName}`);
        expect(await readFile(path.join(outputDir, "modules", fileName), "utf8")).toContain(`# Module: ${module.name}`);
        expect(await readFile(path.join(outputDir, "playbooks", fileName), "utf8")).toContain(`# Playbook: ${module.name}`);
      }

      const hints = await targetPlaybookHints(repoRoot, index, modules.flatMap((module) => module.files));
      expect(hints).toEqual(
        modules.map((module) => {
          const fileName = moduleArtifactFileName(module);
          return {
            module: module.name,
            uri: `codexa://repo/codebase/playbooks/${encodeURIComponent(fileName)}`,
            path: `.codex/codebase/playbooks/${fileName}`
          };
        })
      );

      await writeFile(path.join(outputDir, "modules", "web-foo.md"), "legacy stale module\n", "utf8");
      await writeFile(path.join(outputDir, "playbooks", "obsolete.md"), "stale playbook\n", "utf8");
      await writeArtifacts(index, outputDir);
      expect((await readdir(path.join(outputDir, "modules"))).sort()).toEqual(expectedNames);
      expect((await readdir(path.join(outputDir, "playbooks"))).filter((name) => name !== "README.md").sort()).toEqual(expectedNames);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale Markdown files without deleting Markdown-named directories", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-prune-types-"));
    const outputDir = path.join(repoRoot, ".codex/codebase");
    const index = minimalIndex(repoRoot, collisionModules().slice(0, 1));

    try {
      await writeArtifacts(index, outputDir);
      for (const area of ["modules", "playbooks"]) {
        const preservedDir = path.join(outputDir, area, "manual.md");
        await mkdir(preservedDir);
        await writeFile(path.join(preservedDir, "keep.txt"), "host-local content\n", "utf8");
        await writeFile(path.join(outputDir, area, "stale.md"), "stale generated content\n", "utf8");
      }

      await expect(writeArtifacts(index, outputDir)).resolves.toBeUndefined();
      for (const area of ["modules", "playbooks"]) {
        expect(await readFile(path.join(outputDir, area, "manual.md", "keep.txt"), "utf8")).toBe("host-local content\n");
        expect(await readdir(path.join(outputDir, area))).not.toContain("stale.md");
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  itPosix("unlinks retained-name symlinks before publishing generated Markdown", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-prune-symlink-"));
    const outputDir = path.join(repoRoot, ".codex/codebase");
    const module = collisionModules()[0]!;
    const index = minimalIndex(repoRoot, [module]);
    const generatedName = moduleArtifactFileName(module);
    const outsideSentinel = path.join(repoRoot, "outside.md");

    try {
      await writeArtifacts(index, outputDir);
      await writeFile(outsideSentinel, "outside sentinel\n", "utf8");
      for (const area of ["modules", "playbooks"]) {
        const generatedPath = path.join(outputDir, area, generatedName);
        await rm(generatedPath, { force: true });
        await symlink(outsideSentinel, generatedPath);
      }

      await writeArtifacts(index, outputDir);

      expect(await readFile(outsideSentinel, "utf8")).toBe("outside sentinel\n");
      const modulePath = path.join(outputDir, "modules", generatedName);
      const playbookPath = path.join(outputDir, "playbooks", generatedName);
      expect((await lstat(modulePath)).isSymbolicLink()).toBe(false);
      expect((await lstat(playbookPath)).isSymbolicLink()).toBe(false);
      expect(await readFile(modulePath, "utf8")).toContain(`# Module: ${module.name}`);
      expect(await readFile(playbookPath, "utf8")).toContain(`# Playbook: ${module.name}`);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  itPosix("replaces fixed artifact symlinks without overwriting their targets", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-fixed-symlink-"));
    const outputDir = path.join(repoRoot, ".codex/codebase");
    const index = minimalIndex(repoRoot, collisionModules().slice(0, 1));
    const outsideSentinel = path.join(repoRoot, "outside.md");

    try {
      await writeArtifacts(index, outputDir);
      await writeFile(outsideSentinel, "outside sentinel\n", "utf8");
      const readme = path.join(outputDir, "README.md");
      await rm(readme);
      await symlink(outsideSentinel, readme);

      await writeArtifacts(index, outputDir);

      expect(await readFile(outsideSentinel, "utf8")).toBe("outside sentinel\n");
      expect((await lstat(readme)).isSymbolicLink()).toBe(false);
      expect(await readFile(readme, "utf8")).toContain("# Codexa Codebase Context");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  itPosix("rejects redirected module directories before pruning external files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-directory-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-artifact-directory-target-"));
    const outputDir = path.join(repoRoot, ".codex/codebase");
    const index = minimalIndex(repoRoot, collisionModules().slice(0, 1));
    const sentinel = path.join(outside, "stale.md");

    try {
      await writeArtifacts(index, outputDir);
      await writeFile(sentinel, "outside sentinel\n", "utf8");
      await rm(path.join(outputDir, "modules"), { recursive: true });
      await symlink(outside, path.join(outputDir, "modules"), "dir");

      await expect(writeArtifacts(index, outputDir)).rejects.toThrow(/managed artifact|symbolic link/u);
      expect(await readFile(sentinel, "utf8")).toBe("outside sentinel\n");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

function collisionModules(): ModuleClusterFact[] {
  return [
    moduleFact("module-web-slash", "web/foo", "web/foo/index.ts", "path"),
    moduleFact("module-web-hyphen", "web-foo", "web-foo/index.ts", "path"),
    moduleFact("module-billing-upper", "Billing", "Billing/index.ts", "path"),
    moduleFact("module-billing-lower", "billing", "billing/index.ts", "path")
  ];
}

function moduleFact(
  id: string,
  name: string,
  file: string,
  clusterKind: NonNullable<ModuleClusterFact["clusterKind"]>
): ModuleClusterFact {
  return {
    id,
    type: "ModuleCluster",
    source: "heuristic",
    confidence: "heuristic",
    snapshotId: SNAPSHOT_ID,
    indexedAt: INDEXED_AT,
    name,
    files: [file],
    summary: `Module ${name}`,
    rank: 10,
    clusterKind
  };
}

function minimalIndex(repoRoot: string, modules: ModuleClusterFact[]): CodexaIndex {
  return {
    schemaVersion: 1,
    snapshot: {
      id: SNAPSHOT_ID,
      type: "RepoSnapshot",
      source: "git",
      confidence: "authoritative",
      snapshotId: SNAPSHOT_ID,
      indexedAt: INDEXED_AT,
      repoRoot,
      gitRoot: repoRoot,
      headCommit: "0123456789abcdef",
      dirtyFiles: []
    },
    freshness: {
      schemaVersion: 1,
      snapshotId: SNAPSHOT_ID,
      repoRoot,
      gitRoot: repoRoot,
      headCommit: "0123456789abcdef",
      indexedAt: INDEXED_AT,
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: false,
      stale: false,
      reason: "test-fixture",
      parserErrorCount: 0
    },
    files: [],
    symbols: [],
    usageSites: [],
    imports: [],
    testEdges: [],
    graphEdges: [],
    workflows: [],
    modules,
    risks: [],
    parserErrors: []
  };
}

function readableStem(fileName: string): string {
  return fileName.replace(/-[a-f0-9]{16}\.md$/u, "");
}
