import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, getFreshness } from "../src/indexer.js";
import { CODEXA_INDEX_REVISION } from "../src/index-revision.js";
import { findContextQuery, statusQuery } from "../src/queries.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("index checkout identity", () => {
  it("auto-refreshes an unchanged readable legacy index revision", async () => {
    const repo = await createRepo("codexa-identity-revision-");
    await buildIndex({ repoRoot: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const freshnessPath = path.join(repo, ".codex/codebase/freshness.json");
    const legacyIndex = JSON.parse(await readFile(indexPath, "utf8"));
    const legacyFreshness = JSON.parse(await readFile(freshnessPath, "utf8"));
    delete legacyIndex.indexRevision;
    delete legacyIndex.freshness.indexRevision;
    legacyIndex.symbols = [];
    delete legacyFreshness.indexRevision;
    await writeFile(indexPath, `${JSON.stringify(legacyIndex)}\n`, "utf8");
    await writeFile(freshnessPath, `${JSON.stringify(legacyFreshness, null, 2)}\n`, "utf8");

    const standaloneFreshness = await getFreshness(repo, undefined, { recover: false });
    expect(standaloneFreshness).toMatchObject({ stale: true, reason: "index-revision-changed", headCommit: head });
    const status = await statusQuery(repo, { recover: false });
    expect(status.freshness).toMatchObject({ stale: true, reason: "index-revision-changed", headCommit: head });

    const repaired = await findContextQuery(repo, "identityValue", 5, { autoRefresh: true });
    expect(repaired.freshness).toMatchObject({ stale: false, indexRevision: CODEXA_INDEX_REVISION, headCommit: head });
    expect(repaired.text).toContain("auto-refreshed from index-revision-changed");
    expect(repaired.text).toContain("identityValue");
    const rebuiltIndex = JSON.parse(await readFile(indexPath, "utf8"));
    const rebuiltFreshness = JSON.parse(await readFile(freshnessPath, "utf8"));
    expect(rebuiltIndex).toMatchObject({ indexRevision: CODEXA_INDEX_REVISION, freshness: { indexRevision: CODEXA_INDEX_REVISION } });
    expect(rebuiltFreshness).toMatchObject({ indexRevision: CODEXA_INDEX_REVISION, stale: false, headCommit: head });
  });

  it("rejects a stale HEAD without auto-refresh and repairs it when enabled", async () => {
    const repo = await createRepo("codexa-identity-head-");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/value.ts"), "export const identityValue = 2\nexport const currentHeadOnly = true\n", "utf8");
    commitAll(repo, "advance head");

    const status = await statusQuery(repo, { recover: false });
    expect(status.freshness.reason).toBe("head-commit-changed");
    await expect(findContextQuery(repo, "currentHeadOnly", 5, { autoRefresh: false })).rejects.toThrow(
      /index identity mismatch \(head-commit-changed\)/u
    );

    const repaired = await findContextQuery(repo, "currentHeadOnly", 5, { autoRefresh: true });
    expect(repaired.freshness.stale).toBe(false);
    expect(repaired.text).toContain("auto-refreshed from head-commit-changed");
    expect(repaired.text).toContain("currentHeadOnly");
  });

  it("rejects an index copied from another linked worktree even at the same HEAD", async () => {
    const repo = await createRepo("codexa-identity-worktree-");
    const worktree = `${repo}-linked`;
    cleanupPaths.push(worktree);
    execFileSync("git", ["worktree", "add", "-b", "identity-linked", worktree], { cwd: repo, stdio: "ignore" });
    await buildIndex({ repoRoot: repo });
    await mkdir(path.join(worktree, ".codex"), { recursive: true });
    await cp(path.join(repo, ".codex/codebase"), path.join(worktree, ".codex/codebase"), { recursive: true });

    await expect(findContextQuery(worktree, "identityValue", 5, { autoRefresh: false })).rejects.toThrow(
      /index identity mismatch \(snapshot-repo-root-mismatch\)/u
    );

    const repaired = await findContextQuery(worktree, "identityValue", 5, { autoRefresh: true });
    expect(repaired.freshness.stale).toBe(false);
    expect(repaired.freshness.repoRoot).toBe(path.resolve(worktree));
    expect(repaired.text).toContain("auto-refreshed from snapshot-repo-root-mismatch");
  });

  it("forces a rebuild when only the stored snapshot identity is inconsistent", async () => {
    const repo = await createRepo("codexa-identity-snapshot-");
    await buildIndex({ repoRoot: repo });
    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { snapshot: { repoRoot: string } };
    index.snapshot.repoRoot = path.join(path.dirname(repo), "different-checkout");
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

    const status = await statusQuery(repo, { recover: false });
    expect(status.freshness).toMatchObject({ stale: true, reason: "snapshot-repo-root-mismatch" });
    expect(status.text).toContain("Identity: blocked (snapshot-repo-root-mismatch)");
    expect((status.data as { identityIssue?: { reason?: string } }).identityIssue?.reason).toBe("snapshot-repo-root-mismatch");
    await expect(findContextQuery(repo, "identityValue", 5, { autoRefresh: false })).rejects.toThrow("snapshot-repo-root-mismatch");
    const repaired = await findContextQuery(repo, "identityValue", 5, { autoRefresh: true });
    expect(repaired.freshness.stale).toBe(false);
    expect(repaired.text).toContain("auto-refreshed from snapshot-repo-root-mismatch");
  });

  it("treats a symlink alias as the same physical checkout", async () => {
    const repo = await createRepo("codexa-identity-symlink-");
    await buildIndex({ repoRoot: repo });
    const alias = `${repo}-alias`;
    cleanupPaths.push(alias);
    await symlink(repo, alias, "dir");

    const status = await statusQuery(alias, { recover: false });
    expect(status.freshness.stale).toBe(false);
    const context = await findContextQuery(alias, "identityValue", 5, { autoRefresh: false });
    expect(context.text).toContain("identityValue");
  });

  it("keeps freshness diagnostic access but blocks MCP evidence and artifacts on a stale HEAD", async () => {
    const repo = await createRepo("codexa-identity-mcp-");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/value.ts"), "export const identityValue = 3\n", "utf8");
    commitAll(repo, "advance mcp head");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-index-identity-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const brief = await client.callTool({ name: "task_brief", arguments: { task: "inspect identityValue", limit: 4 } });
      expect(brief.isError).toBe(true);
      expect(JSON.stringify(brief)).toContain("head-commit-changed");

      const freshness = await client.callTool({ name: "freshness", arguments: {} });
      expect(freshness.isError).not.toBe(true);
      expect(JSON.stringify(freshness)).toContain("head-commit-changed");
      const freshnessResource = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
      expect(String(freshnessResource.contents?.[0]?.text)).toContain("head-commit-changed");
      await expect(client.readResource({ uri: "codexa://repo/codebase/README.md" })).rejects.toThrow("head-commit-changed");
    } finally {
      await client.close();
    }
  });

  it("auto-refreshes and revalidates before serving a generated MCP artifact", async () => {
    const repo = await createRepo("codexa-identity-mcp-resource-");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/value.ts"), "export const identityValue = 4\n", "utf8");
    commitAll(repo, "advance resource head");
    const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-index-identity-resource-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const readme = await client.readResource({ uri: "codexa://repo/codebase/README.md" });
      expect(String(readme.contents?.[0]?.text)).toContain(currentHead);
      const freshness = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
      expect(JSON.parse(String(freshness.contents?.[0]?.text))).toMatchObject({ stale: false, headCommit: currentHead });
    } finally {
      await client.close();
    }
  });

  it("rejects dirty generated artifacts without auto-refresh while keeping freshness readable", async () => {
    const repo = await createRepo("codexa-identity-mcp-dirty-resource-");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/value.ts"), "export const identityValue = 5\n", "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), "dist/cli.js"), "serve", repo, "--no-auto-refresh", "--tools", "full"],
      stderr: "pipe"
    });
    const client = new Client({ name: "codexa-dirty-artifact-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const freshness = await client.readResource({ uri: "codexa://repo/codebase/freshness.json" });
      expect(String(freshness.contents?.[0]?.text)).toContain("dirty-files-changed");
      await expect(client.readResource({ uri: "codexa://repo/codebase/README.md" })).rejects.toThrow("dirty-files-changed");
    } finally {
      await client.close();
    }
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src/value.ts"), "export const identityValue = 1\n", "utf8");
  commitAll(repo, "fixture");
  return repo;
}

function commitAll(repo: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", message], {
    cwd: repo,
    stdio: "ignore"
  });
}
