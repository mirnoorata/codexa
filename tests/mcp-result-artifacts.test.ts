import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_RESULT_ARTIFACT_DIR,
  createMcpResultArtifactRouter,
  mcpResultArtifactUri,
  persistMcpResultArtifact,
  readMcpResultArtifact,
  rememberProtectedMcpResultId,
  type McpResultArtifactBinding
} from "../src/mcp/result-artifacts.js";
import type { QueryResult } from "../src/types.js";

const binding: McpResultArtifactBinding = {
  tool: "task_brief",
  checkout: { repoRoot: "/tmp/repo", gitHead: "active-head", routingSource: "configured-root", workspaceSessionId: "session-1" },
  freshness: { snapshotId: "snapshot-1", headCommit: "indexed-head", indexedAt: "2026-07-13T00:00:00.000Z", stale: false, missing: false, reason: "fresh" }
};

function result(index = 1): QueryResult {
  return {
    freshness: {
      schemaVersion: 1,
      snapshotId: `snapshot-${index}`,
      repoRoot: "/tmp/repo",
      gitRoot: "/tmp/repo",
      headCommit: "indexed-head",
      indexedAt: "2026-07-13T00:00:00.000Z",
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: false,
      stale: false,
      reason: "fresh",
      parserErrorCount: 0
    },
    text: `detailed ${index}`,
    data: { mode: "task_brief", actionability: "orientation", index }
  };
}

describe("content-addressed MCP result artifacts", () => {
  it("round-trips the exact detailed packet and rejects a corrupt pre-existing target", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-"));
    const router = createMcpResultArtifactRouter();
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    const packet = result();
    const reference = await persistMcpResultArtifact(repo, packet, { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router);
    expect(await readMcpResultArtifact(repo, reference.id)).toBe(JSON.stringify(packet));

    const filePath = path.join(repo, MCP_RESULT_ARTIFACT_DIR, `${reference.id}.json`);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ tool: "task_brief", checkout: { repoRoot: repo, gitHead: "active-head" }, freshness: { headCommit: "indexed-head" } });
    await writeFile(filePath, JSON.stringify({ ...stored, payload: "corrupt" }), "utf8");
    await expect(persistMcpResultArtifact(repo, packet, { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router)).rejects.toThrow(/content-address|payload|match/u);
  });

  it("refuses symlink result records and bounds the protected session set", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-link-"));
    const router = createMcpResultArtifactRouter();
    const reference = await persistMcpResultArtifact(repo, result(), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router);
    const filePath = path.join(repo, MCP_RESULT_ARTIFACT_DIR, `${reference.id}.json`);
    const outside = path.join(repo, "outside.json");
    await writeFile(outside, "{}", "utf8");
    await rm(filePath);
    await symlink(outside, filePath);
    await expect(readMcpResultArtifact(repo, reference.id)).rejects.toThrow(/regular file|symbolic link|ELOOP/u);

    const protectedIds = new Set<string>();
    for (let index = 0; index < 100; index += 1) rememberProtectedMcpResultId(protectedIds, `mr_${String(index).padStart(64, "0")}`);
    expect(protectedIds.size).toBe(64);
    expect([...protectedIds][0]).toBe(`mr_${String(36).padStart(64, "0")}`);
    expect((await readdir(path.join(repo, MCP_RESULT_ARTIFACT_DIR))).length).toBeGreaterThan(0);
  });

  it("rejects a symlinked artifact parent before creating anything outside the repository", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-parent-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-outside-"));
    await symlink(outside, path.join(repo, ".codex"));

    await expect(persistMcpResultArtifact(repo, result(), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, createMcpResultArtifactRouter())).rejects.toThrow(/symbolic link|escapes/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("retains exactly the last 256 unpinned cross-writer issuances while keeping live root routing", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-concurrent-"));
    const references: Awaited<ReturnType<typeof persistMcpResultArtifact>>[] = [];
    for (let index = 0; index < 270; index += 1) {
      const writer = createMcpResultArtifactRouter();
      references.push(await persistMcpResultArtifact(repo, result(index), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, writer, new Set()));
      await writer.close();
    }
    const router = createMcpResultArtifactRouter();
    const routedReference = await persistMcpResultArtifact(repo, result(269), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set());

    await expect(readMcpResultArtifact(repo, references[0]!.id)).rejects.toThrow(/ENOENT/u);
    expect(await readMcpResultArtifact(repo, references[14]!.id)).toContain('"index":14');
    expect(await readMcpResultArtifact(repo, references.at(-1)!.id)).toContain('"index":269');
    expect(router.resolve(resultRepoLocator(routedReference.uri))).toBe(await fsRealpath(repo));
    expect((await readdir(path.join(repo, MCP_RESULT_ARTIFACT_DIR))).filter((name) => name.endsWith(".json"))).toHaveLength(256);

    const lockPath = path.join(repo, MCP_RESULT_ARTIFACT_DIR, ".prune.lock");
    await mkdir(lockPath);
    await expect(persistMcpResultArtifact(repo, result(14), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set())).rejects.toThrow(/retention lock/u);
    await expect(persistMcpResultArtifact(repo, result(999), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set())).rejects.toThrow(/retention lock/u);
    expect((await readdir(path.join(repo, MCP_RESULT_ARTIFACT_DIR))).filter((name) => name.endsWith(".json"))).toHaveLength(256);
    await rm(lockPath, { recursive: true });
    await persistMcpResultArtifact(repo, result(1000), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set());
    await expect(readMcpResultArtifact(repo, references[14]!.id)).rejects.toThrow(/ENOENT/u);
    await router.close();
  }, 60_000);

  it("keeps every promised result readable and refuses a 257th unique same-session URI", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-live-cap-"));
    const router = createMcpResultArtifactRouter();
    const references: Awaited<ReturnType<typeof persistMcpResultArtifact>>[] = [];
    for (let index = 0; index < 256; index += 1) {
      references.push(await persistMcpResultArtifact(repo, result(index), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router));
    }

    await expect(
      persistMcpResultArtifact(repo, result(256), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router)
    ).rejects.toThrow(/live retention capacity.*bounded self-contained decision receipt/u);
    for (const [index, reference] of references.entries()) {
      expect(await readMcpResultArtifact(repo, reference.id)).toContain(`"index":${index}`);
      expect(router.resolve(resultRepoLocator(reference.uri))).toBe(await fsRealpath(repo));
    }
    expect((await readdir(path.join(repo, MCP_RESULT_ARTIFACT_DIR))).filter((name) => name.endsWith(".json"))).toHaveLength(256);
    await router.close();
  }, 60_000);

  it("does not let a concurrent MCP server process evict another live session's promised results", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-process-leases-"));
    const childSession = await launchArtifactSession(repo, 0, 128);
    const localRouter = createMcpResultArtifactRouter();
    const localReferences: Awaited<ReturnType<typeof persistMcpResultArtifact>>[] = [];
    const nextRouter = createMcpResultArtifactRouter();
    try {
      for (let index = 128; index < 256; index += 1) {
        localReferences.push(await persistMcpResultArtifact(repo, result(index), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, localRouter));
      }
      await expect(
        persistMcpResultArtifact(repo, result(256), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, nextRouter)
      ).rejects.toThrow(/live retention capacity/u);

      for (const reference of childSession.references) {
        expect(await readMcpResultArtifact(repo, reference.id)).toContain('"index":');
      }
      for (const [offset, reference] of localReferences.entries()) {
        expect(await readMcpResultArtifact(repo, reference.id)).toContain(`"index":${offset + 128}`);
      }

      childSession.child.stdin.end();
      await childSession.exit;
      const next = await persistMcpResultArtifact(repo, result(256), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, nextRouter);
      expect(await readMcpResultArtifact(repo, next.id)).toContain('"index":256');
      for (const [offset, reference] of localReferences.entries()) {
        expect(await readMcpResultArtifact(repo, reference.id)).toContain(`"index":${offset + 128}`);
      }
    } finally {
      if (childSession.child.exitCode === null) childSession.child.kill("SIGTERM");
      await childSession.exit.catch(() => undefined);
      await localRouter.close();
      await nextRouter.close();
    }
  }, 60_000);

  it("never reaps an old retention lock whose exact owner process is still live", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-live-lock-"));
    const seedRouter = createMcpResultArtifactRouter();
    await persistMcpResultArtifact(repo, result(1), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, seedRouter);
    await seedRouter.close();
    const lockPath = path.join(repo, MCP_RESULT_ARTIFACT_DIR, ".prune.lock");
    await mkdir(lockPath);
    const owner = {
      schemaVersion: 1,
      token: `ml_${"a".repeat(32)}`,
      pid: process.pid,
      acquiredAt: "2026-07-13T00:00:00.000Z"
    };
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8");
    await utimes(lockPath, new Date(0), new Date(0));

    const contender = createMcpResultArtifactRouter();
    const stalled = await Promise.allSettled([
      persistMcpResultArtifact(repo, result(2), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, contender),
      persistMcpResultArtifact(repo, result(3), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, contender)
    ]);
    expect(stalled).toHaveLength(2);
    for (const outcome of stalled) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/retention/u);
    }
    expect(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))).toEqual(owner);
    expect(await readdir(lockPath)).toEqual(["owner.json"]);
    await rm(lockPath, { recursive: true });
    const recovered = await persistMcpResultArtifact(repo, result(4), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, contender);
    expect(await readMcpResultArtifact(repo, recovered.id)).toContain('"index":4');
    await contender.close();
  });

  it.skipIf(process.platform === "win32")("reaps special-file lock metadata without blocking persistence", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-fifo-owner-"));
    const lockPath = path.join(repo, MCP_RESULT_ARTIFACT_DIR, ".prune.lock");
    await mkdir(lockPath, { recursive: true });
    execFileSync("mkfifo", [path.join(lockPath, "owner.json")]);
    await utimes(lockPath, new Date(0), new Date(0));

    const session = await launchArtifactSession(repo, 9, 1, 2_000);
    try {
      expect(session.references).toHaveLength(1);
      expect(await readMcpResultArtifact(repo, session.references[0]!.id)).toContain('"index":9');
    } finally {
      session.child.stdin.end();
      await session.exit;
    }
  }, 5_000);

  it("serializes concurrent issuances and cleans a stale crash temp before the next promise", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-parallel-"));
    const router = createMcpResultArtifactRouter();
    const references = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      persistMcpResultArtifact(repo, result(index), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set())
    ));
    for (const [index, reference] of references.entries()) {
      expect(await readMcpResultArtifact(repo, reference.id)).toContain(`"index":${index}`);
    }
    const directory = path.join(repo, MCP_RESULT_ARTIFACT_DIR);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const staleTemp = path.join(directory, `mr_${"f".repeat(64)}.json.999.00000000-0000-4000-8000-000000000000.tmp`);
    await writeFile(staleTemp, "crash-remnant", "utf8");
    await utimes(staleTemp, new Date(0), new Date(0));
    const next = await persistMcpResultArtifact(repo, result(999), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router, new Set());
    expect(await readMcpResultArtifact(repo, next.id)).toContain('"index":999');
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await router.close();
  }, 30_000);

  it("keeps queued issuances compact during a slow but progressing local write", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-slow-local-"));
    const router = createMcpResultArtifactRouter();
    const realUtimes = fs.utimes.bind(fs);
    let delayed = false;
    const utimes = vi.spyOn(fs, "utimes").mockImplementation(async (...args) => {
      if (!delayed && String(args[0]).endsWith(".json")) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      return realUtimes(...args);
    });
    try {
      const references = await Promise.all([
        persistMcpResultArtifact(repo, result(1), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router),
        persistMcpResultArtifact(repo, result(2), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router)
      ]);
      expect(references).toHaveLength(2);
      expect(await readMcpResultArtifact(repo, references[0]!.id)).toContain('"index":1');
      expect(await readMcpResultArtifact(repo, references[1]!.id)).toContain('"index":2');
    } finally {
      utimes.mockRestore();
      await router.close();
    }
  }, 5_000);

  it("keeps committed routes readable and refuses new URIs when a server exceeds its bounded root capacity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-routing-"));
    const router = createMcpResultArtifactRouter();
    const references: Array<{ repo: string; id: string; uri: string }> = [];
    for (let index = 0; index < 270; index += 1) {
      const repo = path.join(workspace, `repo-${String(index).padStart(3, "0")}`);
      await mkdir(repo);
      const pending = persistMcpResultArtifact(repo, result(index), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, router);
      if (index < 256) {
        const reference = await pending;
        references.push({ repo, id: reference.id, uri: reference.uri });
      } else {
        await expect(pending).rejects.toThrow(/routing capacity/u);
      }
    }

    for (const reference of [references[0]!, references[128]!, references.at(-1)!]) {
      const routedRoot = router.resolve(resultRepoLocator(reference.uri));
      expect(routedRoot).toBe(await fsRealpath(reference.repo));
      expect(await readMcpResultArtifact(routedRoot!, reference.id)).toContain(`\"index\":${Number(path.basename(reference.repo).slice(5))}`);
    }
  }, 30_000);

  it("removes matching symlink and directory entries before enforcing the hard record cap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-result-invalid-cap-"));
    const directory = path.join(repo, MCP_RESULT_ARTIFACT_DIR);
    await mkdir(directory, { recursive: true });
    const outside = path.join(repo, "outside-target.json");
    await writeFile(outside, "do-not-delete", "utf8");
    for (let index = 0; index < 256; index += 1) {
      const name = `mr_${index.toString(16).padStart(64, "0")}.json`;
      const target = path.join(directory, name);
      if (index % 2 === 0) await symlink(outside, target);
      else await mkdir(target);
    }

    const reference = await persistMcpResultArtifact(repo, result(777), { ...binding, checkout: { ...binding.checkout, repoRoot: repo } }, createMcpResultArtifactRouter());

    expect(await readMcpResultArtifact(repo, reference.id)).toContain('"index":777');
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([`${reference.id}.json`]);
    expect(await readFile(outside, "utf8")).toBe("do-not-delete");
  });

  it("keeps routed result URIs fixed-size and path-free for a near-limit repository path", () => {
    const router = createMcpResultArtifactRouter();
    const longRoot = `/${Array.from({ length: 300 }, (_, index) => `segment-${index}`).join("/")}`;
    expect(Buffer.byteLength(longRoot, "utf8")).toBeGreaterThan(3_000);
    expect(Buffer.byteLength(longRoot, "utf8")).toBeLessThan(4_096);
    const locator = router.reserve(longRoot);
    expect(locator).toMatch(/^rr_[a-f0-9]{32}$/u);
    const uri = mcpResultArtifactUri(locator!, `mr_${"a".repeat(64)}`);
    expect(uri.length).toBeLessThan(160);
    expect(uri).not.toContain("segment-");
    router.complete(longRoot, locator!, true);
    expect(router.resolve(locator!)).toBe(longRoot);
  });
});

async function fsRealpath(value: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(value);
}

async function launchArtifactSession(
  repo: string,
  start: number,
  count: number,
  readinessTimeoutMs = 15_000
): Promise<{
  child: ChildProcessWithoutNullStreams;
  references: Array<{ id: string; uri: string }>;
  exit: Promise<void>;
}> {
  const moduleUrl = new URL("../src/mcp/result-artifacts.ts", import.meta.url).href;
  const source = `
    import { createMcpResultArtifactRouter, persistMcpResultArtifact } from ${JSON.stringify(moduleUrl)};
    const repo = ${JSON.stringify(repo)};
    const start = ${start};
    const count = ${count};
    const router = createMcpResultArtifactRouter();
    const references = [];
    const binding = {
      tool: "task_brief",
      checkout: { repoRoot: repo, gitHead: "active-head", routingSource: "configured-root", workspaceSessionId: "child-session" },
      freshness: { snapshotId: "snapshot-1", headCommit: "indexed-head", indexedAt: "2026-07-13T00:00:00.000Z", stale: false, missing: false, reason: "fresh" }
    };
    for (let index = start; index < start + count; index += 1) {
      const result = {
        freshness: {
          schemaVersion: 1, snapshotId: \`snapshot-\${index}\`, repoRoot: "/tmp/repo", gitRoot: "/tmp/repo",
          headCommit: "indexed-head", indexedAt: "2026-07-13T00:00:00.000Z", dirtyFiles: [], dirtyFileHashes: {},
          indexedDirtyFileHashes: {}, indexedDirtyFiles: [], missing: false, stale: false, reason: "fresh", parserErrorCount: 0
        },
        text: \`detailed \${index}\`,
        data: { mode: "task_brief", actionability: "orientation", index }
      };
      references.push(await persistMcpResultArtifact(repo, result, binding, router));
    }
    process.stdout.write(JSON.stringify(references) + "\\n");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("end", resolve));
    await router.close();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`artifact child exited with code=${String(code)} signal=${String(signal)}: ${stderr}`));
    });
  });
  void exit.catch(() => undefined);
  const references = await new Promise<Array<{ id: string; uri: string }>>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`artifact child timed out after ${readinessTimeoutMs}ms: ${stderr}`)));
    }, readinessTimeoutMs);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      child.stdout.off("data", onData);
      try {
        const parsed = JSON.parse(stdout.slice(0, newline)) as Array<{ id: string; uri: string }>;
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => reject(new Error(`artifact child exited before readiness with code=${String(code)} signal=${String(signal)}: ${stderr}`)));
    });
  });
  return { child, references, exit };
}

function resultRepoLocator(uri: string): string {
  const match = /^codexa:\/\/repo\/mcp-results\/([^/]+)\/mr_[a-f0-9]{64}$/u.exec(uri);
  if (!match?.[1]) throw new Error(`missing repository locator in ${uri}`);
  return match[1];
}
