import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Codexa hook CLI", () => {
  it("rejects malformed integer options instead of truncating them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-cli-integer-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "repo-map", repo, "--limit", "12abc"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid integer: 12abc");
  });

  it("keeps hook-post-edit advisory when query setup fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-missing-git-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Codexa: post-edit review unavailable:");
    expect(result.stdout).toContain("Codexa: hook is advisory; continuing without blocking the edit.");
    await expect(readFile(path.join(repo, ".codex/cache/codexa-hooks/events.ndjson"), "utf8")).rejects.toThrow();
  });

  it("keeps session-start advisory when query setup fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-missing-git-"));
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "session-start", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Codexa status unavailable:");
    expect(result.stdout).toContain("Codexa startup hook is advisory");
  });

  it("routes workspace-root session-start hooks through the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-session-start-focused-"));
    const repo = path.join(workspace, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `- Focused project: \`${repo}\`.\n`, "utf8");

    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "dist/cli.js"), "session-start", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Codexa context for ${repo}:`);
    expect(result.stdout).toContain(`Repo: ${repo}`);
    expect(result.stdout).not.toContain("Codexa status unavailable:");
    expect(result.stdout).not.toContain("Failed to read git status");
    const latest = JSON.parse(await readFile(path.join(workspace, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { status: string };
    expect(latest.status).toBe("ok");
  });

  it("routes workspace-root edit hooks through the focused repository", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexa-edit-hooks-focused-"));
    const repo = path.join(workspace, "repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "WORKING.md"), `- Focused project: \`${repo}\`.\n`, "utf8");
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const indexed = spawnSync(process.execPath, [cli, "index", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);
    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const preEdit = spawnSync(process.execPath, [cli, "hook-pre-edit", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(preEdit.status).toBe(0);
    expect(preEdit.stdout).toContain("Codexa: no change-plan snapshot is available");
    expect(preEdit.stdout).not.toContain("Failed to read git status");

    const postEdit = spawnSync(process.execPath, [cli, "hook-post-edit", workspace], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(postEdit.status).toBe(0);
    expect(postEdit.stdout).toContain("Codexa post-edit review");
    expect(postEdit.stdout).not.toContain("Failed to read git status");
    const latest = JSON.parse(await readFile(path.join(workspace, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { hook: string; status: string };
    expect(latest).toMatchObject({ hook: "post-edit", status: "ok" });
  });

  it("skips duplicate hook-post-edit reviews for an unchanged dirty tree", async () => {
    const repo = await createHookFixtureRepo();
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const indexed = spawnSync(process.execPath, [cli, "index", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(indexed.status).toBe(0);

    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");

    const first = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Codexa post-edit review");

    const second = spawnSync(process.execPath, [cli, "hook-post-edit", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Codexa: post-edit review unchanged since last hook run");

    const outcomeFiles = (await readdir(path.join(repo, ".codex/cache/codexa-outcomes"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "latest.json" && entry !== "latest-hook-review.json"
    );
    expect(outcomeFiles).toHaveLength(1);

    const hookEvents = (await readFile(path.join(repo, ".codex/cache/codexa-hooks/events.ndjson"), "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { hook: string; status: string; reason?: string });
    expect(hookEvents).toMatchObject([
      { hook: "post-edit", status: "ok", reason: "reviewed" },
      { hook: "post-edit", status: "skipped", reason: "duplicate-dirty-tree" }
    ]);
    const latestHook = JSON.parse(await readFile(path.join(repo, ".codex/cache/codexa-hooks/latest.json"), "utf8")) as { status: string; reason?: string };
    expect(latestHook).toMatchObject({ status: "skipped", reason: "duplicate-dirty-tree" });
  });

  it("reports doctor diagnostics for installed wiring and latest hook events", async () => {
    const repo = await createHookFixtureRepo();
    const cli = path.resolve(process.cwd(), "dist/cli.js");

    const init = spawnSync(process.execPath, [cli, "init", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(init.status).toBe(0);

    const sessionStart = spawnSync(process.execPath, [cli, "session-start", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(sessionStart.status).toBe(0);

    const doctorJson = spawnSync(process.execPath, [cli, "doctor", repo, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(doctorJson.status).toBe(0);
    const data = JSON.parse(doctorJson.stdout) as {
      config: { mcpServerConfigured: boolean; codexHooksEnabled: boolean };
      hooks: { sessionStart: boolean; preEdit: boolean; postEdit: boolean };
      index: { missing: boolean } | null;
      latestHookEvent: { hook: string; status: string } | null;
      hookEventsPath: string;
    };
    expect(data.config).toMatchObject({ mcpServerConfigured: true, codexHooksEnabled: true });
    expect(data.hooks).toMatchObject({ sessionStart: true, preEdit: true, postEdit: true });
    expect(data.index?.missing).toBe(false);
    expect(data.latestHookEvent).toMatchObject({ hook: "session-start", status: "ok" });
    expect(data.hookEventsPath).toBe(".codex/cache/codexa-hooks/events.ndjson");

    const doctorText = spawnSync(process.execPath, [cli, "doctor", repo], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(doctorText.status).toBe(0);
    expect(doctorText.stdout).toContain("Codexa doctor");
    expect(doctorText.stdout).toContain("Latest hook: session-start ok");
  });
});

async function createHookFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-hook-dedupe-"));
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
