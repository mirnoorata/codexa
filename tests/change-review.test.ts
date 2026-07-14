import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { changePlanQuery, changeReviewQuery } from "../src/queries.js";
import type { ChangeReviewData } from "../src/query/change-review.js";

describe("committed change review", () => {
  it("produces one deterministic base-to-head receipt with impact and test evidence", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'hello v2' }\n", "utf8");
    commitAll(repo, "feat: update greeting");
    await buildIndex({ repoRoot: repo });

    const first = await changeReviewQuery(repo, { base, head: "HEAD" }, { autoRefresh: false });
    const second = await changeReviewQuery(repo, { base, head: "HEAD" }, { autoRefresh: false });
    const data = first.data as ChangeReviewData;

    expect(data.identity.baseCommit).toBe(base);
    expect(data.identity.headCommit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(data.change.changedFiles).toEqual(["src/main.ts"]);
    expect(data.change.insertions).toBe(1);
    expect(data.change.deletions).toBe(1);
    expect(data.impact.affectedFiles.map((entry) => entry.path)).toContain("tests/main.test.ts");
    expect(data.verification.recommendedTests.map((entry) => entry.path)).toContain("tests/main.test.ts");
    expect(data.verification.recommendedTests.every((entry) => !entry.command?.includes(repo))).toBe(true);
    expect(second.data).toEqual(first.data);
  });

  it("compares a local change-plan snapshot and only blocks deterministic drift in fail mode", async () => {
    const repo = await createReviewRepo();
    await buildIndex({ repoRoot: repo });
    const plan = await changePlanQuery(
      repo,
      { task: "Update greeting", taskId: "review-plan", files: ["src/main.ts"], diff: false, saveSnapshot: true },
      { autoRefresh: false }
    );
    expect((plan.data as { snapshot?: { taskId?: string } }).snapshot?.taskId).toBe("review-plan");
    const base = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'planned' }\n", "utf8");
    await writeFile(path.join(repo, "src/extra.ts"), "export const extra = true\n", "utf8");
    commitAll(repo, "feat: planned and extra edits");
    await buildIndex({ repoRoot: repo });

    const observe = (await changeReviewQuery(repo, { base, taskId: "review-plan" }, { autoRefresh: false })).data as ChangeReviewData;
    expect(observe.plan.conformance).toBe("drifted");
    expect(observe.plan.unplannedFiles).toContain("src/extra.ts");
    expect(observe.verdict.blocking).toBe(false);

    const fail = (await changeReviewQuery(repo, { base, taskId: "review-plan", mode: "fail" }, { autoRefresh: false })).data as ChangeReviewData;
    expect(fail.verdict).toMatchObject({ status: "blocked", blocking: true });
  });

  it("fails closed for a dirty index, mismatched head, and option-shaped refs", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await buildIndex({ repoRoot: repo });
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'dirty' }\n", "utf8");
    await expect(changeReviewQuery(repo, { base }, { autoRefresh: true })).rejects.toThrow(/fresh index built from a clean checkout/u);

    git(repo, "checkout", "--", "src/main.ts");
    git(repo, "commit", "--allow-empty", "-m", "test: advance head");
    await buildIndex({ repoRoot: repo });
    await expect(changeReviewQuery(repo, { base: "--help" }, { autoRefresh: false })).rejects.toThrow(/unable to resolve Git ref --help/u);
    await expect(changeReviewQuery(repo, { base, head: base }, { autoRefresh: false })).rejects.toThrow(/does not match indexed checkout/u);
  });

  it("rejects an index built from a reverted dirty overlay until it is refreshed", async () => {
    const repo = await createReviewRepo();
    const head = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'dirty overlay' }\n", "utf8");
    await buildIndex({ repoRoot: repo });
    git(repo, "checkout", "--", "src/main.ts");

    await expect(changeReviewQuery(repo, { base: head }, { autoRefresh: false })).rejects.toThrow(/fresh index built from a clean checkout/u);
    const refreshed = (await changeReviewQuery(repo, { base: head }, { autoRefresh: true })).data as ChangeReviewData;
    expect(refreshed.actionability).toBe("no_changes");
  });

  it("returns a non-blocking no-change receipt for an identical base and head", async () => {
    const repo = await createReviewRepo();
    await buildIndex({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    const data = (await changeReviewQuery(repo, { base: head, head }, { autoRefresh: false })).data as ChangeReviewData;
    expect(data.actionability).toBe("no_changes");
    expect(data.change.changedFileCount).toBe(0);
    expect(data.verdict).toMatchObject({ status: "pass", blocking: false });
  });

  it("uses the verification ledger instead of crediting masked command text", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'ledger' }\n", "utf8");
    commitAll(repo, "feat: ledger review");
    await buildIndex({ repoRoot: repo });
    const initial = (await changeReviewQuery(repo, { base }, { autoRefresh: false })).data as ChangeReviewData;
    const command = initial.verification.recommendedTests.find((test) => test.command)?.command;
    expect(command).toBeTruthy();

    const masked = (await changeReviewQuery(repo, { base, ranCommands: [`${command} || true`] }, { autoRefresh: false })).data as ChangeReviewData;
    expect(masked.verification.coveredTests).toEqual([]);
    expect(masked.verification.trustPosture).toBe("reported-not-witnessed");

    const reported = (await changeReviewQuery(repo, { base, ranCommands: [command!] }, { autoRefresh: false })).data as ChangeReviewData;
    expect(reported.verification.coveredTests).toContain("tests/main.test.ts");
    expect(reported.verification.ledger.find((entry) => entry.target === "tests/main.test.ts")?.trustTier).toBe("reported");
  });

  it("keeps portable plan drift advisory and requires local plans to bind to the merge base", async () => {
    const repo = await createReviewRepo();
    await buildIndex({ repoRoot: repo });
    const planResult = await changePlanQuery(
      repo,
      { task: "Portable plan", taskId: "portable-plan", files: ["src/main.ts"], diff: false, saveSnapshot: true },
      { autoRefresh: false }
    );
    const snapshot = (planResult.data as { snapshot?: unknown }).snapshot;
    expect(snapshot).toBeTruthy();
    const base = git(repo, "rev-parse", "HEAD");
    await mkdir(path.join(repo, "plans"), { recursive: true });
    await writeFile(path.join(repo, "plans/review.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "src/extra.ts"), "export const extra = true\n", "utf8");
    commitAll(repo, "feat: portable plan drift");
    await buildIndex({ repoRoot: repo });

    const portable = (await changeReviewQuery(repo, { base, planSnapshot: "plans/review.json", mode: "fail" }, { autoRefresh: false })).data as ChangeReviewData;
    expect(portable.plan).toMatchObject({ source: "portable", trust: "repo-file-advisory", conformance: "drifted", boundToRange: true });
    expect(portable.verdict.blocking).toBe(false);
    expect(portable.verdict.status).toBe("attention");
    expect(portable.verdict.reasons).toContainEqual(expect.stringContaining("advisory portable plan drift"));

    await symlink("../plans/review.json", path.join(repo, ".codex/portable-link.json"));
    await expect(changeReviewQuery(repo, { base, planSnapshot: ".codex/portable-link.json" }, { autoRefresh: false })).rejects.toThrow(/non-symlink/u);
    await writeFile(path.join(repo, ".codex/oversized-plan.json"), "x".repeat(1024 * 1024 + 1), "utf8");
    await expect(changeReviewQuery(repo, { base, planSnapshot: ".codex/oversized-plan.json" }, { autoRefresh: false })).rejects.toThrow(/exceeds 1048576 bytes/u);

    git(repo, "commit", "--allow-empty", "-m", "test: move review base");
    const laterBase = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'later' }\n", "utf8");
    commitAll(repo, "feat: later local plan edit");
    await buildIndex({ repoRoot: repo });
    const local = (await changeReviewQuery(repo, { base: laterBase, taskId: "portable-plan", mode: "fail" }, { autoRefresh: false })).data as ChangeReviewData;
    expect(local.plan).toMatchObject({ source: "local", trust: "local-cache", status: "unavailable", boundToRange: false });
    expect(local.verdict.blocking).toBe(true);
  });

  it("excludes Codexa control files from both file counts and diff statistics", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex/control.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'visible' }\n", "utf8");
    git(repo, "add", "src/main.ts");
    git(repo, "add", "-f", ".codex/control.txt");
    git(repo, "commit", "-m", "feat: visible and control changes");
    await buildIndex({ repoRoot: repo });
    const data = (await changeReviewQuery(repo, { base }, { autoRefresh: false })).data as ChangeReviewData;
    expect(data.change.changedFiles).toEqual(["src/main.ts"]);
    expect(data.change.changedFileCount).toBe(1);
    expect(data.change.insertions).toBe(1);
    expect(data.change.deletions).toBe(1);
  });

  it("treats planned renames as bound scope without reporting the historical path as unindexed", async () => {
    const repo = await createReviewRepo();
    await buildIndex({ repoRoot: repo });
    await changePlanQuery(
      repo,
      { task: "Rename main", taskId: "rename-plan", files: ["src/main.ts"], diff: false, saveSnapshot: true },
      { autoRefresh: false }
    );
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "src/main.ts", "src/renamed.ts");
    commitAll(repo, "refactor: rename main");
    await buildIndex({ repoRoot: repo });
    const data = (await changeReviewQuery(repo, { base, taskId: "rename-plan", mode: "fail" }, { autoRefresh: false })).data as ChangeReviewData;
    expect(data.change.changedFiles).toEqual(["src/main.ts", "src/renamed.ts"]);
    expect(data.change.unindexedChanged).toEqual([]);
    expect(data.plan).toMatchObject({ conformance: "matched", boundToRange: true });
    expect(data.verdict.blocking).toBe(false);
  });

  it("keeps rename classification deterministic when repository config sets a hostile low limit", async () => {
    const repo = await createReviewRepo();
    const original = Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index}\n`).join("");
    await writeFile(path.join(repo, "src/first.ts"), original, "utf8");
    await writeFile(path.join(repo, "src/second.ts"), original.replaceAll("value", "other"), "utf8");
    commitAll(repo, "test: add rename fixtures");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "config", "diff.renameLimit", "1");
    git(repo, "mv", "src/first.ts", "src/first-renamed.ts");
    git(repo, "mv", "src/second.ts", "src/second-renamed.ts");
    await writeFile(path.join(repo, "src/first-renamed.ts"), `${original}export const added = true\n`, "utf8");
    await writeFile(path.join(repo, "src/second-renamed.ts"), `${original.replaceAll("value", "other")}export const added = true\n`, "utf8");
    commitAll(repo, "refactor: rename multiple modified files");
    await buildIndex({ repoRoot: repo });

    const data = (await changeReviewQuery(repo, { base }, { autoRefresh: false })).data as ChangeReviewData;
    expect(data.change.entries.filter((entry) => entry.kind === "renamed")).toHaveLength(2);
    expect(data.change.changedFileCount).toBe(2);
  });

  it("returns a zero-change receipt when a range only changes ignored Codexa control files", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await writeFile(path.join(repo, ".codex/control.txt"), "control only\n", "utf8");
    git(repo, "add", "-f", ".codex/control.txt");
    git(repo, "commit", "-m", "chore: update control state");
    await buildIndex({ repoRoot: repo });
    const data = (await changeReviewQuery(repo, { base }, { autoRefresh: false })).data as ChangeReviewData;
    expect(data.actionability).toBe("no_changes");
    expect(data.change).toMatchObject({ changedFileCount: 0, changedFiles: [], insertions: 0, deletions: 0 });
  });

  it("maps a blocking fail-mode receipt to CLI exit code 2", async () => {
    const repo = await createReviewRepo();
    const base = git(repo, "rev-parse", "HEAD");
    await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'cli fail' }\n", "utf8");
    commitAll(repo, "feat: cli fail receipt");
    await buildIndex({ repoRoot: repo });
    const cli = path.resolve("dist/cli.js");
    const report = JSON.stringify({ command: "npm test", exitCode: 1 });

    const fail = spawnSync(process.execPath, [cli, "review", repo, "--base", base, "--mode", "fail", "--format", "json", "--ran-command-report", report, "--no-auto-refresh"], { encoding: "utf8" });
    expect(fail.status).toBe(2);
    expect(JSON.parse(fail.stdout).verdict).toMatchObject({ status: "blocked", blocking: true });

    const observe = spawnSync(process.execPath, [cli, "review", repo, "--base", base, "--mode", "observe", "--format", "json", "--ran-command-report", report, "--no-auto-refresh"], { encoding: "utf8" });
    expect(observe.status).toBe(0);
    expect(JSON.parse(observe.stdout).verdict).toMatchObject({ status: "attention", blocking: false });
  });
});

async function createReviewRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-change-review-"));
  git(repo, "init");
  git(repo, "config", "user.email", "tests@codexa.local");
  git(repo, "config", "user.name", "Codexa Tests");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), ".codex/\n", "utf8");
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "change-review-fixture", scripts: { test: "vitest run" } }, null, 2)}\n`, "utf8");
  await writeFile(path.join(repo, "src/main.ts"), "export function greeting() { return 'hello' }\n", "utf8");
  await writeFile(path.join(repo, "tests/main.test.ts"), "import { greeting } from '../src/main.js'\nexport const expected = greeting()\n", "utf8");
  commitAll(repo, "test: create fixture");
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
