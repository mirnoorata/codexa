import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, buildIndexLocked, loadIndex } from "../src/indexer.js";
import { CODEXA_INDEX_REVISION } from "../src/index-revision.js";
import { statusQuery } from "../src/queries.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";

describe("Codexa schema contracts", () => {
  it("versions verification coverage independently from the command classifier", () => {
    expect(CURRENT_VERIFICATION_PROVENANCE).toMatchObject({
      commandCoverageClassifierVersion: "command-coverage-v7",
      verificationCoverageVersion: "verification-coverage-v5",
      verificationLedgerVersion: "verification-ledger-v4"
    });
  });

  it("writes versioned index, freshness, and NDJSON fact artifacts", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const codebaseDir = path.join(repo, ".codex/codebase");
    const index = JSON.parse(await readFile(path.join(codebaseDir, "index.json"), "utf8"));
    const freshness = JSON.parse(await readFile(path.join(codebaseDir, "freshness.json"), "utf8"));
    const relationalPackets = JSON.parse(await readFile(path.join(codebaseDir, "relational-packets.json"), "utf8"));
    const relationalGraph = JSON.parse(await readFile(path.join(codebaseDir, "relational-graph.json"), "utf8"));
    const summaryPrompts = (await readFile(path.join(codebaseDir, "packet-summary-prompts.ndjson"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const facts = (await readFile(path.join(codebaseDir, "facts.ndjson"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));

    expect(index.schemaVersion).toBe(1);
    expect(index.indexRevision).toBe(CODEXA_INDEX_REVISION);
    expect(freshness.schemaVersion).toBe(1);
    expect(freshness.indexRevision).toBe(CODEXA_INDEX_REVISION);
    expect(relationalPackets.schemaVersion).toBe(1);
    expect(relationalGraph.schemaVersion).toBe(1);
    expect(summaryPrompts.every((prompt) => prompt.schemaVersion === 1)).toBe(true);
    expect(index.freshness.schemaVersion).toBe(1);
    expect(index.freshness.indexRevision).toBe(CODEXA_INDEX_REVISION);
    expect(index.graphEdges).toBeInstanceOf(Array);
    expect(index.workflows).toBeInstanceOf(Array);
    expect(index.workflowMembershipSpill).toBeTypeOf("object");
    expect(Object.keys(index.workflowMembershipSpill ?? {}).sort()).toEqual(index.workflows.map((workflow) => workflow.id).sort());
    expect(JSON.stringify(relationalPackets)).not.toContain("workflowMembershipSpill");
    expect(facts.some((fact) => Object.prototype.hasOwnProperty.call(fact, "workflowMembershipSpill"))).toBe(false);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((fact) => typeof fact.id === "string" && typeof fact.type === "string" && fact.snapshotId === index.freshness.snapshotId)).toBe(true);
  });

  it("loads older v1 bundles as readable but stale compatibility inputs", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    delete index.indexRevision;
    delete index.freshness.indexRevision;
    delete index.graphEdges;
    delete index.workflows;
    delete index.workflowMembershipSpill;
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const loaded = await loadIndex(repo);
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.indexRevision).toBeUndefined();
    expect(loaded?.freshness.indexRevision).toBeUndefined();
    expect(loaded?.graphEdges).toEqual([]);
    expect(loaded?.workflows).toEqual([]);
    const status = await statusQuery(repo, { recover: false });
    expect(status.freshness).toMatchObject({ stale: true, reason: "index-revision-changed" });
  });

  it("loads revision-2 workflow indexes without spill as stale rebuild inputs", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.indexRevision = 2;
    index.freshness.indexRevision = 2;
    index.workflows = [{
      id: "workflow:revision-2",
      type: "WorkflowTrace",
      source: "heuristic",
      confidence: "derived",
      snapshotId: index.snapshot.snapshotId,
      indexedAt: index.snapshot.indexedAt,
      path: "src/main.ts",
      workflowKind: "module",
      title: "revision-2 workflow",
      entryPath: "src/main.ts",
      relatedFiles: ["src/main.ts"],
      tests: [],
      steps: [{ kind: "entry", label: "main", path: "src/main.ts", confidence: "derived", reason: "legacy fixture" }],
      summary: "Readable legacy workflow",
      rank: 1
    }];
    delete index.workflowMembershipSpill;
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

    const loaded = await loadIndex(repo, { recover: false });
    expect(loaded?.indexRevision).toBe(2);
    expect(loaded?.freshness.indexRevision).toBe(2);
    expect(loaded?.workflows.length).toBeGreaterThan(0);
    expect(loaded?.workflowMembershipSpill).toEqual({});
  });

  it("rejects a current-revision index that loses internal workflow membership spill", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    delete index.workflowMembershipSpill;
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

    expect(await loadIndex(repo, { recover: false })).toBeNull();
  });

  it("reports a corrupt index bundle without recovering or trusting detached freshness metadata", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await writeFile(path.join(repo, ".codex/codebase/index.json"), "{ corrupt index\n", "utf8");

    const status = await statusQuery(repo, { recover: false });
    expect(status.freshness.missing).toBe(true);
    expect(status.freshness.reason).toBe("missing-index");
    expect(status.text).toContain("Parser errors: 0");
    expect(await readFile(path.join(repo, ".codex/codebase/index.json"), "utf8")).toBe("{ corrupt index\n");
  });

  it("rejects a future live schema and recovers the newest valid backup", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const codebaseDir = path.join(repo, ".codex/codebase");
    const backupDir = path.join(repo, ".codex/.codebase.backup-schema");
    await rename(codebaseDir, backupDir);
    await mkdir(codebaseDir, { recursive: true });
    const future = JSON.parse(await readFile(path.join(backupDir, "index.json"), "utf8"));
    future.schemaVersion = 999;
    await writeFile(path.join(codebaseDir, "index.json"), `${JSON.stringify(future, null, 2)}\n`, "utf8");

    const recovered = await loadIndex(repo);
    expect(recovered?.schemaVersion).toBe(1);
    expect(recovered?.files.map((file) => file.path)).toContain("src/main.ts");
    expect(JSON.parse(await readFile(path.join(codebaseDir, "index.json"), "utf8")).schemaVersion).toBe(1);
  });

  it("recovers a valid backup after an interrupted artifact publication", async () => {
    const repo = await createSchemaFixtureRepo();
    await buildIndex({ repoRoot: repo });

    const codebaseDir = path.join(repo, ".codex/codebase");
    const backupDir = path.join(repo, ".codex/.codebase.backup-interrupted");
    const tempDir = path.join(repo, ".codex/.codebase.tmp-interrupted");
    await rename(codebaseDir, backupDir);
    await mkdir(tempDir, { recursive: true });
    await writeFile(path.join(tempDir, "index.json"), "{ partial write\n", "utf8");

    const recovered = await loadIndex(repo);
    expect(recovered?.schemaVersion).toBe(1);
    expect(recovered?.files.map((file) => file.path)).toContain("src/main.ts");
    expect(JSON.parse(await readFile(path.join(codebaseDir, "index.json"), "utf8")).schemaVersion).toBe(1);
  });

  it("removes stale dead-owner index locks before publishing", async () => {
    const repo = await createSchemaFixtureRepo();
    const lockDir = path.join(repo, ".codex/cache/codexa-index.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "stale-owner",
        processStartTime: "stale",
        startedAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        repoRoot: repo
      })}\n`,
      "utf8"
    );

    const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    expect(index.files.map((file) => file.path)).toContain("src/main.ts");
    await expect(readFile(path.join(lockDir, "owner.json"), "utf8")).rejects.toThrow();
  });
});

async function createSchemaFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-schema-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });
  return repo;
}
