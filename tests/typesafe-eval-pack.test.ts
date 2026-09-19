import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error Source-only evaluation tooling has no declaration file.
import { loadTypeSafeEvalPack, summarizeRetrievalRows } from "../scripts/typesafe-eval-pack.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("pins public checkout identity and rejects split leakage and modified evaluation source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexa-eval-pack-")); roots.push(root);
  const checkout = path.join(root, "fixture"); await mkdir(checkout);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("remote", "add", "origin", "https://github.com/OWNER/REPO.git");
  await writeFile(path.join(checkout, "code.ts"), "export const value = 1;\n");
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture");
  const pack = {
    schemaVersion: 1,
    repositories: [{ id: "fixture", url: "https://github.com/OWNER/REPO", commit: git("rev-parse", "HEAD"), partition: "evaluation" }],
    cases: [{ id: "one", repository: "fixture", query: "value", target: "code.ts", line: 1, kind: "behavior" }]
  };
  const filename = path.join(root, "pack.json");
  const save = () => writeFile(filename, JSON.stringify(pack));
  await save(); expect((await loadTypeSafeEvalPack(filename, root)).cases).toEqual(pack.cases);
  pack.repositories.push({ ...pack.repositories[0], id: "alias", partition: "calibration" });
  await save(); await expect(loadTypeSafeEvalPack(filename, root)).rejects.toThrow("both partitions");
  pack.repositories.pop(); pack.cases[0].target = "../outside.ts";
  await save(); await expect(loadTypeSafeEvalPack(filename, root)).rejects.toThrow();
  pack.cases[0].target = "code.ts"; await save();
  await writeFile(path.join(checkout, "extra.ts"), "export const extra = 1;\n");
  await expect(loadTypeSafeEvalPack(filename, root)).rejects.toThrow("untracked evaluation source");
  await rm(path.join(checkout, "extra.ts"));
  await writeFile(path.join(checkout, "code.ts"), "export const value = 2;\n");
  await expect(loadTypeSafeEvalPack(filename, root)).rejects.toThrow("must be clean");
});

it("counts absent candidates as misses and unreported provider tokens as unknown", () => {
  const rows = [
    { rank: 0, latencyMs: 1, typesafe: { status: "fallback", requestAttempted: true } },
    { rank: 1, latencyMs: 3, typesafe: { status: "skipped", requestAttempted: false } }
  ];
  expect(summarizeRetrievalRows(rows)).toMatchObject({ cases: 2, candidateRecall: .5, top1: .5, mrr: .5, requests: 1, inputTokens: null, outputTokens: null });
  expect(summarizeRetrievalRows(rows.slice(1))).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0 });
});
