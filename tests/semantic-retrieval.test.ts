import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
import { searchQuery } from "../src/query/search.js";
import { retrieveForTask } from "../src/retrieval.js";
import { buildSemanticIndex, semanticOptionsFromQueryOptions } from "../src/semantic-retrieval.js";

describe("semantic retrieval lane", () => {
  it("does not report only-test anchors when source anchors are also present", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-retrieval-source-test-anchors-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await mkdir(path.join(repo, "tests"), { recursive: true });
      await writeFile(path.join(repo, "src", "runtime.ts"), "export function renderRuntime() { return 'ready' }\n", "utf8");
      await writeFile(
        path.join(repo, "tests", "runtime.test.ts"),
        "import { renderRuntime } from '../src/runtime'\nexport function assertRuntimeRender() { return renderRuntime() }\n",
        "utf8"
      );
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });

      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const retrieval = await retrieveForTask(index, "Fix renderRuntime runtime behavior", 8);

      expect(retrieval.intentConfidence.anchors).toContain("src/runtime.ts");
      expect(retrieval.matches.map((match) => match.file.path)).toContain("tests/runtime.test.ts");
      expect(retrieval.intentConfidence.missingAnchors).not.toContain("only test anchors for edit prompt");
      expect(retrieval.intentConfidence.verdict).toBe("edit-ready");
      expect(retrieval.intentConfidence.editReady).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("builds a local-command semantic cache and fuses semantic matches into retrieval", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-retrieval-"));
    let embedderDir: string | undefined;
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src", "billing"), { recursive: true });
      await mkdir(path.join(repo, "src", "auth"), { recursive: true });
      await mkdir(path.join(repo, "src", "domain"), { recursive: true });
      await writeFile(
        path.join(repo, "src", "billing", "subscriptions.ts"),
        [
          "export function invoiceSubscription(customerId: string) {",
          "  const paymentStatus = `billing invoice payment for ${customerId}`;",
          "  return { customerId, paymentStatus, subscriptionLifecycle: true };",
          "}"
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(
        path.join(repo, "src", "domain", "processor.ts"),
        [
          "export function runDomainProcess() {",
          "  // billing invoice payment subscription lifecycle renewal context lives only in source prose",
          "  return 'ok';",
          "}"
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(
        path.join(repo, "src", "auth", "session.ts"),
        [
          "export function loginSession(userId: string) {",
          "  return { userId, authenticated: true, passwordPolicy: 'strict' };",
          "}"
        ].join("\n") + "\n",
        "utf8"
      );
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });

      embedderDir = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-embedder-"));
      const embedder = path.join(embedderDir, "embedder.mjs");
      await writeFile(embedder, localEmbeddingCommandSource(), "utf8");
      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const built = await buildSemanticIndex(repo, index, {
        provider: "local-command",
        command: process.execPath,
        args: [embedder],
        batchSize: 2,
        timeoutMs: 5000
      });

      expect(built.provider).toBe("local-command");
      expect(built.chunkCount).toBeGreaterThanOrEqual(2);
      const semanticQueryOptions = {
        semanticProvider: "local-command" as const,
        semanticCommand: process.execPath,
        semanticArgs: [embedder],
        semanticTimeoutMs: 5000,
        semanticBatchSize: 2
      };
      const semanticOptions = semanticOptionsFromQueryOptions(repo, semanticQueryOptions);
      const retrieval = await retrieveForTask(
        index,
        "subscription invoice lifecycle",
        5,
        semanticOptions
      );

      expect(retrieval.semantic.status).toBe("ok");
      const billingMatch = retrieval.matches.find((match) => match.file.path === "src/billing/subscriptions.ts");
      expect(billingMatch).toBeTruthy();
      expect(billingMatch?.lanes.semantic).toBeGreaterThan(0);
      expect(billingMatch?.reasons.some((reason) => reason.includes("semantic src/billing/subscriptions.ts"))).toBe(true);
      const semanticAnchorRetrieval = await retrieveForTask(index, "fix renewal lifecycle invoice behavior", 8, semanticOptions);
      const semanticOnlyMatch = semanticAnchorRetrieval.matches.find((match) => match.file.path === "src/domain/processor.ts");
      expect(semanticOnlyMatch).toBeTruthy();
      expect(semanticOnlyMatch?.lanes.semantic).toBeGreaterThanOrEqual(9);
      expect(semanticOnlyMatch?.lanes.exact ?? 0).toBe(0);
      expect(semanticOnlyMatch?.lanes.symbol ?? 0).toBe(0);
      expect(semanticAnchorRetrieval.intentConfidence.anchors).toContain("src/domain/processor.ts");
      expect(semanticAnchorRetrieval.intentConfidence.reasons).toContain("1 semantic anchor(s)");
      const search = await searchQuery(repo, { query: "fix renewal lifecycle invoice behavior", limit: 5 }, { ...semanticQueryOptions, autoRefresh: false });
      expect(search.text).toContain("Hybrid semantic search:");
      expect(search.text).toContain("Semantic lane: ok");
      expect(search.text).toContain("Raw exact hits: 0; ranked anchor:");
      expect(search.text).toContain("Codexa hybrid targets:");
      expect(search.text).toContain("Relational packets:");
      const searchData = search.data as {
        rawExactHitCount: number;
        rankedAnchors: Array<{ kind: string; path: string; label: string; lanes: string[] }>;
        relationalPackets: { clusterGroups: Array<{ name: string; topSymbols: string[] }> };
      };
      expect(searchData.rawExactHitCount).toBe(0);
      expect(searchData.rankedAnchors.some((anchor) => anchor.kind === "symbol" && anchor.path === "src/domain/processor.ts" && anchor.label === "runDomainProcess")).toBe(true);
      expect(searchData.rankedAnchors.find((anchor) => anchor.path === "src/domain/processor.ts")?.lanes).toContain("semantic");
      expect(searchData.relationalPackets.clusterGroups.some((group) => group.name === "src")).toBe(true);
    } finally {
      if (embedderDir) {
        await rm(embedderDir, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("uses CODEXA_SEMANTIC_COMMAND for local-command semantic builds", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-env-command-"));
    const previousCommand = process.env.CODEXA_SEMANTIC_COMMAND;
    const previousArgs = process.env.CODEXA_SEMANTIC_ARGS_JSON;
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "index.ts"), "export const invoice = 'billing payment subscription'\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      const embedder = path.join(repo, "embedder.mjs");
      await writeFile(embedder, localEmbeddingCommandSource(), "utf8");
      process.env.CODEXA_SEMANTIC_COMMAND = process.execPath;
      process.env.CODEXA_SEMANTIC_ARGS_JSON = JSON.stringify([embedder]);

      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const built = await buildSemanticIndex(repo, index, { provider: "local-command", timeoutMs: 5000 });

      expect(built.provider).toBe("local-command");
      expect(built.chunkCount).toBeGreaterThan(0);
    } finally {
      restoreEnv("CODEXA_SEMANTIC_COMMAND", previousCommand);
      restoreEnv("CODEXA_SEMANTIC_ARGS_JSON", previousArgs);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("runs local-command semantic providers with a scrubbed environment", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-scrubbed-env-"));
    const previousSecret = process.env.CODEXA_SECRET_FIXTURE;
    const previousProvider = process.env.CODEXA_SEMANTIC_PROVIDER;
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "index.ts"), "export const invoice = 'billing payment subscription'\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      const envLog = path.join(repo, "semantic-env.json");
      const embedder = path.join(repo, "embedder.mjs");
      await writeFile(
        embedder,
        `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  secret: process.env.CODEXA_SECRET_FIXTURE ?? null,
  provider: process.env.CODEXA_SEMANTIC_PROVIDER ?? null,
  home: process.env.HOME ?? null,
  user: process.env.USER ?? null,
  shell: process.env.SHELL ?? null
}));
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  for (const line of input.split(/\\r?\\n/u)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    console.log(JSON.stringify({ id: item.id, embedding: [1, 0, 0] }));
  }
});
`.trimStart(),
        "utf8"
      );
      process.env.CODEXA_SECRET_FIXTURE = "do-not-forward";
      process.env.CODEXA_SEMANTIC_PROVIDER = "openai";

      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await buildSemanticIndex(repo, index, {
        provider: "local-command",
        command: process.execPath,
        args: [embedder],
        timeoutMs: 5000
      });

      const childEnv = JSON.parse(await readFile(envLog, "utf8")) as { secret?: unknown; provider?: unknown; home?: unknown; user?: unknown; shell?: unknown };
      expect(childEnv.secret).toBeNull();
      expect(childEnv.provider).toBeNull();
      expect(childEnv.home).toBeNull();
      expect(childEnv.user).toBeNull();
      expect(childEnv.shell).toBeNull();
    } finally {
      restoreEnv("CODEXA_SECRET_FIXTURE", previousSecret);
      restoreEnv("CODEXA_SEMANTIC_PROVIDER", previousProvider);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("fails closed when local-command semantic output exceeds the output cap", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-output-cap-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "index.ts"), "export const invoice = 'billing payment subscription'\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      const embedder = path.join(repo, "embedder.mjs");
      await writeFile(embedder, "process.stdout.write('x'.repeat(17 * 1024 * 1024));\n", "utf8");

      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      await expect(
        buildSemanticIndex(repo, index, {
          provider: "local-command",
          command: process.execPath,
          args: [embedder],
          timeoutMs: 5000
        })
      ).rejects.toThrow(/output cap/u);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("loads the manifest-addressed vector file instead of a stale shared vector path", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-content-addressed-"));
    let embedderDir: string | undefined;
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src", "billing.ts"), "export const invoice = 'billing payment subscription lifecycle'\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      embedderDir = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-addressed-embedder-"));
      const embedder = path.join(embedderDir, "embedder.mjs");
      await writeFile(embedder, localEmbeddingCommandSource(), "utf8");

      const index = await buildIndexLocked({ repoRoot: repo, writeArtifacts: true });
      const built = await buildSemanticIndex(repo, index, {
        provider: "local-command",
        model: "local-a",
        command: process.execPath,
        args: [embedder],
        timeoutMs: 5000
      });
      const firstManifest = JSON.parse(await readFile(built.manifestPath, "utf8")) as { vectorsFile?: unknown };
      expect(firstManifest.vectorsFile).toMatch(/^vectors-[a-f0-9]{24}\.jsonl$/u);
      expect(built.vectorPath).toBe(path.join(repo, ".codex/cache/codexa-semantic-v1", String(firstManifest.vectorsFile)));

      const rebuilt = await buildSemanticIndex(repo, index, {
        provider: "local-command",
        model: "local-b",
        command: process.execPath,
        args: [embedder],
        timeoutMs: 5000
      });
      const manifest = JSON.parse(await readFile(rebuilt.manifestPath, "utf8")) as { vectorsFile?: unknown };
      expect(manifest.vectorsFile).toMatch(/^vectors-[a-f0-9]{24}\.jsonl$/u);
      expect(rebuilt.vectorPath).toBe(path.join(repo, ".codex/cache/codexa-semantic-v1", String(manifest.vectorsFile)));
      expect(rebuilt.vectorPath).not.toBe(built.vectorPath);

      await writeFile(path.join(repo, ".codex/cache/codexa-semantic-v1/vectors.jsonl"), "{\"id\":\"stale\",\"embedding\":[999]}\n", "utf8");
      const semanticOptions = semanticOptionsFromQueryOptions(repo, {
        semanticProvider: "local-command",
        semanticCommand: process.execPath,
        semanticArgs: [embedder],
        semanticTimeoutMs: 5000
      });
      const retrieval = await retrieveForTask(index, "subscription lifecycle invoice", 5, semanticOptions);

      expect(retrieval.semantic.status).toBe("ok");
      expect(retrieval.semantic.chunkCount).toBeGreaterThan(0);
      expect(retrieval.matches.map((match) => match.file.path)).toContain("src/billing.ts");
    } finally {
      if (embedderDir) {
        await rm(embedderDir, { recursive: true, force: true });
      }
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("treats oversized semantic cache manifests as unavailable instead of reading them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-oversized-"));
    try {
      await mkdir(path.join(repo, ".codex/cache/codexa-semantic-v1"), { recursive: true });
      await writeFile(path.join(repo, ".codex/cache/codexa-semantic-v1/manifest.json"), `${" ".repeat(140 * 1024)}\n`, "utf8");
      const options = semanticOptionsFromQueryOptions(repo, {});
      expect(options.enabled).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function localEmbeddingCommandSource(): string {
  return `
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const groups = [
    ["billing", "invoice", "subscription", "payment", "customer", "lifecycle"],
    ["auth", "login", "session", "password", "authenticated"],
    ["ui", "render", "component", "button"],
    ["test", "spec", "assert"]
  ];
  for (const line of chunks.join("").split(/\\r?\\n/u)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    const lower = String(item.text ?? "").toLowerCase();
    const embedding = groups.map((terms) => terms.reduce((sum, term) => sum + occurrences(lower, term), 0));
    console.log(JSON.stringify({ id: item.id, embedding }));
  }
});

function occurrences(text, term) {
  return text.split(term).length - 1;
}
`.trimStart();
}
