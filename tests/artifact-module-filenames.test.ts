import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeArtifacts } from "../src/artifacts.js";
import { moduleArtifactFileName } from "../src/module-artifact-name.js";
import { targetPlaybookHints } from "../src/skill-hints.js";
import type { CodexaIndex, ModuleClusterFact } from "../src/types.js";

const INDEXED_AT = "2026-01-02T03:04:05.000Z";
const SNAPSHOT_ID = "artifact-filename-snapshot";

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
