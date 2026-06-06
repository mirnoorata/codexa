import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndexLocked } from "../src/indexer.js";
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
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src", "billing"), { recursive: true });
      await mkdir(path.join(repo, "src", "auth"), { recursive: true });
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

      const embedder = path.join(repo, "embedder.mjs");
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
      const retrieval = await retrieveForTask(
        index,
        "subscription invoice lifecycle",
        5,
        semanticOptionsFromQueryOptions(repo, {
          semanticCommand: process.execPath,
          semanticArgs: [embedder],
          semanticTimeoutMs: 5000,
          semanticBatchSize: 2
        })
      );

      expect(retrieval.semantic.status).toBe("ok");
      const billingMatch = retrieval.matches.find((match) => match.file.path === "src/billing/subscriptions.ts");
      expect(billingMatch).toBeTruthy();
      expect(billingMatch?.lanes.semantic).toBeGreaterThan(0);
      expect(billingMatch?.reasons.some((reason) => reason.includes("semantic src/billing/subscriptions.ts"))).toBe(true);
    } finally {
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
