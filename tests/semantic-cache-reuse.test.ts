import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
import { buildSemanticIndex, semanticOptionsFromQueryOptions } from "../src/semantic-retrieval.js";
import { retrieveForTask } from "../src/retrieval.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-cache-test-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await writeFile(path.join(repo, "billing.ts"), "export function bill() { return 'invoice payment'; }\n");
  await writeFile(path.join(repo, "session.ts"), "export function login() { return 'password session'; }\n");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  const log = path.join(root, "calls.jsonl");
  const command = path.join(root, "embed.mjs");
  await writeFile(command, `import { appendFileSync } from 'node:fs';
    let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => { for (const line of input.trim().split('\\n').filter(Boolean)) {
      const item = JSON.parse(line); appendFileSync(${JSON.stringify(log)}, JSON.stringify(item) + '\\n');
      console.log(JSON.stringify({ id: item.id, embedding: [1, 2, 3] }));
    }});`);
  const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
  const options = { provider: "local-command" as const, command: process.execPath, args: [command], model: "fixture-v1", timeoutMs: 5000 };
  return { root, repo, log, index, options };
}

describe("semantic cache reuse and containment", () => {
  it("reuses unchanged chunks across snapshots, embeds only changed chunks, and supports explicit refresh", async () => {
    const { repo, log, index, options } = await setup();
    const first = await buildSemanticIndex(repo, index, options);
    expect(first.embeddedChunks).toBe(first.chunkCount);
    const calls = await readFile(log, "utf8");
    const second = await buildSemanticIndex(repo, index, options);
    expect(second).toMatchObject({ embeddedChunks: 0, reusedChunks: first.chunkCount, vectorPath: first.vectorPath });
    expect(await readFile(log, "utf8")).toBe(calls);
    const refreshed = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    const third = await buildSemanticIndex(repo, refreshed, options);
    expect(third).toMatchObject({ embeddedChunks: 0, vectorPath: first.vectorPath });
    expect((await readdir(first.cacheDir)).filter((name) => name.startsWith("vectors-"))).toHaveLength(1);
    await writeFile(path.join(repo, "billing.ts"), "export function bill() { return 'invoice payment changed'; }\n");
    const changed = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
    const partial = await buildSemanticIndex(repo, changed, options);
    expect(partial.embeddedChunks).toBeGreaterThan(0);
    expect(partial.reusedChunks).toBeGreaterThan(0);
    expect(partial.embeddedChunks).toBeLessThan(partial.chunkCount);
    const forced = await buildSemanticIndex(repo, changed, { ...options, force: true });
    expect(forced).toMatchObject({ embeddedChunks: forced.chunkCount, reusedChunks: 0 });
    const modelChanged = await buildSemanticIndex(repo, changed, { ...options, model: "fixture-v2" });
    expect(modelChanged).toMatchObject({ embeddedChunks: modelChanged.chunkCount, reusedChunks: 0 });
    expect(modelChanged.vectorPath).not.toBe(forced.vectorPath);
    for (const changedOptions of [{ ...options, dimensions: 3 }, { ...options, args: [...options.args, "new-argument"] }]) {
      const invalidated = await buildSemanticIndex(repo, changed, changedOptions);
      expect(invalidated.embeddedChunks).toBe(invalidated.chunkCount);
      expect((await buildSemanticIndex(repo, changed, changedOptions)).embeddedChunks).toBe(0);
    }
  });

  it.each([".codex", ".codex/cache", ".codex/cache/codexa-semantic-v1"])("rejects redirected %s before invoking the provider", async (relative) => {
    const { root, repo, log, index, options } = await setup();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const target = path.join(repo, relative);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target, "dir");
    await expect(buildSemanticIndex(repo, index, options)).rejects.toThrow();
    await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["symlink", "hardlink", "directory"])("refuses a %s manifest or vector as query input", async (kind) => {
    const { root, repo, index, options } = await setup();
    const built = await buildSemanticIndex(repo, index, options);
    const query = { semantic: true, semanticProvider: "local-command" as const, semanticCommand: process.execPath, semanticArgs: options.args, semanticModel: options.model };
    for (const target of [built.manifestPath, built.vectorPath]) {
      const contents = await readFile(target);
      const outside = path.join(root, `outside-${path.basename(target)}`);
      await writeFile(outside, contents);
      await rm(target);
      if (kind === "directory") await mkdir(target);
      else if (kind === "hardlink") await link(outside, target);
      else await symlink(outside, target);
      const result = await retrieveForTask(index, "billing invoice", 8, semanticOptionsFromQueryOptions(repo, query));
      expect(result.semantic.status).toBe("unavailable");
      await rm(target, { recursive: true, force: true });
      await writeFile(target, contents);
    }
  });

  it("refuses publication if the cache directory is replaced while embedding", async () => {
    const { root, repo, index, options } = await setup();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const cache = path.join(repo, ".codex/cache/codexa-semantic-v1");
    const command = options.args[0];
    const source = await readFile(command, "utf8");
    await writeFile(command, `import { renameSync, symlinkSync } from 'node:fs';
      renameSync(${JSON.stringify(cache)}, ${JSON.stringify(cache + "-old")});
      symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(cache)}, 'dir');\n${source}`);
    await expect(buildSemanticIndex(repo, index, options)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
