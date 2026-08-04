import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEXA_VERSION } from "../src/version.js";
import { createHookFixtureRepo, testEnv, trackedTmpDir } from "./cli-hooks-fixtures.js";

const cli = path.resolve(process.cwd(), "dist/cli.js");

describe("Codexa SessionStart CLI receipt", () => {
  it("emits typed JSON without claiming current-thread MCP activation", async () => {
    const repo = await createHookFixtureRepo();
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    const result = spawnSync(process.execPath, [cli, "session-start", repo, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout) as {
      schemaVersion: number;
      kind: string;
      availability: string;
      repoRoot: string;
      config: { state: string; toolProfile: string };
      index: { state: string };
      threadMcp: { state: string; reason: string };
    };
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      kind: "codexa-session-start",
      availability: "ok",
      repoRoot: repo,
      config: { state: "not-configured", toolProfile: "unknown" },
      index: { state: "missing" },
      threadMcp: { state: "unverified", reason: "session-start-cannot-observe-host-initialize" }
    });
    await expect(
      readFile(path.join(repo, ".codex/cache/codexa-hooks/latest.json"), "utf8")
    ).rejects.toThrow();

    const strictMissing = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(strictMissing.status).toBe(1);
    expect(strictMissing.stderr).toContain("Codexa strict startup check failed:");
    expect(strictMissing.stderr).toContain("config not-configured");
    expect(strictMissing.stderr).toContain("index missing");

    const initialized = spawnSync(process.execPath, [cli, "init", repo], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(initialized.status).toBe(0);
    const strictReady = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(strictReady.status).toBe(0);
    expect(strictReady.stderr).toBe("");
    expect(JSON.parse(strictReady.stdout)).toMatchObject({
      config: { state: "configured", toolProfile: "core" },
      index: { state: "fresh" },
      threadMcp: { state: "unverified" }
    });

    await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 2 }\n", "utf8");
    execFileSync("git", ["add", "src/main.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "advance source"],
      { cwd: repo, stdio: "ignore" }
    );
    const strictStale = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(strictStale.status).toBe(1);
    expect(JSON.parse(strictStale.stdout)).toMatchObject({
      index: { state: "identity-blocked", reason: "head-commit-changed" },
      hints: [expect.stringContaining("codexa index")]
    });

    const strictRefreshed = spawnSync(
      process.execPath,
      [cli, "session-start", repo, "--auto-refresh", "--json", "--strict"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }
    );
    expect(strictRefreshed.status).toBe(0);
    expect(strictRefreshed.stderr).toBe("");
    expect(JSON.parse(strictRefreshed.stdout)).toMatchObject({
      config: { state: "configured", toolProfile: "core" },
      index: { state: "fresh" }
    });
  });

  it("rejects an oversized workspace focus file with a bounded advisory receipt", async () => {
    const workspace = await trackedTmpDir("codexa-session-start-large-focus-");
    const sourceRepo = await createHookFixtureRepo();
    const repo = path.join(workspace, "repo");
    await rename(sourceRepo, repo);
    const focusFile = path.join(workspace, "WORKING.md");
    await writeFile(focusFile, `Focused project: \`${repo}\`\n`, "utf8");
    await truncate(focusFile, 2 * 1024 * 1024 + 1);

    const result = spawnSync(
      process.execPath,
      [cli, "session-start", workspace, "--json", "--workspace-focus-file", focusFile],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 3_000,
        env: testEnv()
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ availability: "unavailable" });
    expect(result.stdout).toContain("workspace-focus-file-size-limit-exceeded");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4096);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a workspace focus file swapped to a FIFO without blocking the production CLI",
    async () => {
      const workspace = await trackedTmpDir("codexa-session-start-fifo-focus-");
      const focusFile = path.join(workspace, "WORKING.md");
      const sourceRepo = await createHookFixtureRepo();
      const repo = path.join(workspace, "repo");
      await rename(sourceRepo, repo);
      await writeFile(focusFile, `Focused project: \`${repo}\`\n`, "utf8");
      const preload = path.join(workspace, "focus-fifo-race-preload.mjs");
      const sentinel = path.join(workspace, "focus-fifo-race-observed");
      await writeFile(
        preload,
        [
          'import { execFileSync } from "node:child_process";',
          'import { promises as fs } from "node:fs";',
          'import path from "node:path";',
          "const originalOpen = fs.open.bind(fs);",
          "let swapped = false;",
          "fs.open = async (file, flags, mode) => {",
          "  if (!swapped && path.resolve(String(file)) === path.resolve(process.env.CODEXA_FIFO_TARGET)) {",
          "    swapped = true;",
          "    await fs.rm(file);",
          '    execFileSync("mkfifo", [String(file)]);',
          '    await fs.writeFile(process.env.CODEXA_FIFO_SENTINEL, "observed\\n");',
          "  }",
          "  return originalOpen(file, flags, mode);",
          "};",
          ""
        ].join("\n"),
        "utf8"
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          cli,
          "session-start",
          workspace,
          "--json",
          "--workspace-focus-file",
          focusFile
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 3_000,
          env: {
            ...testEnv(),
            CODEXA_FIFO_TARGET: focusFile,
            CODEXA_FIFO_SENTINEL: sentinel
          }
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ availability: "unavailable" });
      expect(result.stdout).toContain("workspace-focus-file-changed-during-read");
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4096);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("observed\n");
    }
  );

  it.skipIf(process.platform === "win32")(
    "degrades instead of blocking when dirty-file hashing is swapped to a FIFO",
    async () => {
      const repo = await createHookFixtureRepo();
      expect(
        spawnSync(process.execPath, [cli, "init", repo], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: testEnv()
        }).status
      ).toBe(0);
      const target = path.join(repo, "src/main.ts");
      await writeFile(target, "export function main() { return 2 }\n", "utf8");
      const preload = path.join(repo, "dirty-fifo-race-preload.mjs");
      const sentinel = path.join(repo, "dirty-fifo-race-observed");
      await writeFile(
        preload,
        [
          'import { execFileSync } from "node:child_process";',
          'import { promises as fs } from "node:fs";',
          'import path from "node:path";',
          "const originalOpen = fs.open.bind(fs);",
          "let swapped = false;",
          "fs.open = async (file, flags, mode) => {",
          "  if (!swapped && path.resolve(String(file)) === path.resolve(process.env.CODEXA_FIFO_TARGET)) {",
          "    swapped = true;",
          "    await fs.rm(file);",
          '    execFileSync("mkfifo", [String(file)]);',
          '    await fs.writeFile(process.env.CODEXA_FIFO_SENTINEL, "observed\\n");',
          "  }",
          "  return originalOpen(file, flags, mode);",
          "};",
          ""
        ].join("\n"),
        "utf8"
      );

      const result = spawnSync(
        process.execPath,
        ["--import", preload, cli, "session-start", repo, "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 3_000,
          env: {
            ...testEnv(),
            CODEXA_FIFO_TARGET: target,
            CODEXA_FIFO_SENTINEL: sentinel
          }
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        availability: string;
        index: { state: string };
      };
      expect(receipt.availability).toBe("ok");
      expect(receipt.index.state).not.toBe("fresh");
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4096);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("observed\n");
    }
  );

  it.skipIf(process.platform === "win32")(
    "emits an advisory receipt before the host ceiling when Git probes stall",
    async () => {
      const repo = await createHookFixtureRepo();
      const fakeBin = await trackedTmpDir("codexa-session-start-slow-git-");
      const fakeGit = path.join(fakeBin, "git");
      await writeFile(fakeGit, "#!/bin/sh\nsleep 5\nexit 1\n", "utf8");
      await chmod(fakeGit, 0o755);
      const env = {
        ...testEnv(),
        CODEXA_SESSION_START_BUDGET_MS: "1000",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
      };

      const startedAt = Date.now();
      const result = spawnSync(
        process.execPath,
        [cli, "session-start", repo, "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 4_000,
          env
        }
      );
      expect(result.error).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ availability: "unavailable" });
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(4096);
    }
  );

  it("preserves completed facets when the aggregate deadline expires during status", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const delayedIndex = path.join(repo, ".codex/codebase/index.json");
    const preload = path.join(repo, "delayed-index-read-preload.mjs");
    await writeFile(
      preload,
      [
        'import { promises as fs } from "node:fs";',
        'import path from "node:path";',
        "const originalOpen = fs.open.bind(fs);",
        "let delayed = false;",
        "fs.open = async (file, ...args) => {",
        "  if (!delayed && path.resolve(String(file)) === path.resolve(process.env.CODEXA_DELAYED_INDEX)) {",
        "    delayed = true;",
        "    await new Promise((resolve) => setTimeout(resolve, 1500));",
        "  }",
        "  return originalOpen(file, ...args);",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      ["--import", preload, cli, "session-start", repo, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 3_000,
        env: {
          ...testEnv(),
          CODEXA_DELAYED_INDEX: delayedIndex,
          CODEXA_SESSION_START_BUDGET_MS: "1000"
        }
      }
    );
    expect(result.error).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      availability: "unavailable",
      repoRoot: repo,
      routing: { state: "resolved", source: "configured-root" },
      config: { state: "configured", toolProfile: "core" },
      setup: { state: "not-required" },
      index: {
        error: expect.stringMatching(
          /session-start-total-budget-exhausted:1000ms:(?:index|complete)$/u
        )
      }
    });
  });

  it("stops scheduling dirty-file stats after the aggregate deadline", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        writeFile(path.join(repo, `slow-dirty-${String(index).padStart(3, "0")}.ts`), `export const value${index} = ${index};\n`, "utf8")
      )
    );
    const preload = path.join(repo, "delayed-dirty-stats-preload.mjs");
    const marker = path.join(repo, "delayed-dirty-stats-count.txt");
    await writeFile(
      preload,
      [
        'import { promises as fs, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "const originalLstat = fs.lstat.bind(fs);",
        "let delayedStats = 0;",
        "fs.lstat = async (file, ...args) => {",
        '  if (path.basename(String(file)).startsWith("slow-dirty-")) {',
        "    delayedStats += 1;",
        "    await new Promise((resolve) => setTimeout(resolve, 250));",
        "  }",
        "  return originalLstat(file, ...args);",
        "};",
        'process.on("exit", () => writeFileSync(process.env.CODEXA_DIRTY_STAT_MARKER, `${delayedStats}\\n`));',
        ""
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      ["--import", preload, cli, "session-start", repo, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 4_000,
        env: {
          ...testEnv(),
          CODEXA_DIRTY_STAT_MARKER: marker,
          CODEXA_SESSION_START_BUDGET_MS: "1000"
        }
      }
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(2_500);
    expect(result.stdout).toContain("session-start-total-budget-exhausted:1000ms:dirty-file-stat");
    const delayedStats = Number((await readFile(marker, "utf8")).trim());
    expect(delayedStats).toBeGreaterThan(0);
    expect(delayedStats).toBeLessThan(160);
  });

  it.skipIf(process.platform === "win32")(
    "does not block on or mutate advisory hook telemetry during SessionStart",
    async () => {
      const repo = await createHookFixtureRepo();
      const hookDirectory = path.join(repo, ".codex/cache/codexa-hooks");
      const eventsPath = path.join(hookDirectory, "events.ndjson");
      const latestPath = path.join(hookDirectory, "latest.json");
      await mkdir(hookDirectory, { recursive: true });
      execFileSync("mkfifo", [eventsPath]);
      await writeFile(latestPath, "latest-sentinel\n", "utf8");

      const result = spawnSync(
        process.execPath,
        [cli, "session-start", repo, "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 3_000,
          env: {
            ...testEnv(),
            CODEXA_SESSION_START_BUDGET_MS: "1000"
          }
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "codexa-session-start" });
      await expect(readFile(latestPath, "utf8")).resolves.toBe("latest-sentinel\n");
    }
  );

  it("does not record advisory telemetry through redirected managed state", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const externalRoot = await trackedTmpDir("codexa-session-start-redirected-state-");
    const redirectedState = path.join(externalRoot, "managed-state");
    await rename(path.join(repo, ".codex"), redirectedState);
    await symlink(redirectedState, path.join(repo, ".codex"), "dir");

    const result = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      availability: "unavailable",
      routing: { state: "unavailable" },
      config: {
        state: "invalid",
        reason: expect.stringMatching(/refuses redirected or non-directory managed state/u)
      }
    });
    await expect(
      readFile(path.join(redirectedState, "cache/codexa-hooks/events.ndjson"), "utf8")
    ).rejects.toThrow();
    await expect(
      readFile(path.join(redirectedState, "cache/codexa-hooks/latest.json"), "utf8")
    ).rejects.toThrow();
  });

  it("does not auto-refresh through a redirected managed cache", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo, "--no-index"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const externalRoot = await trackedTmpDir("codexa-session-start-cache-target-");
    await rename(path.join(repo, ".codex/cache"), path.join(repo, ".codex/cache-before-redirect"));
    await symlink(externalRoot, path.join(repo, ".codex/cache"), "dir");

    const result = spawnSync(
      process.execPath,
      [cli, "session-start", repo, "--auto-refresh", "--json", "--strict"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      availability: "unavailable",
      index: {
        state: "unavailable",
        error: expect.stringMatching(/managed state is unsafe.*refuses redirected or non-directory managed state/u)
      }
    });
    expect(await readdir(externalRoot)).toEqual([]);
  });

  it("rejects unrelated launchers and bounds excessive enabled tools", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");

    await writeFile(configPath, config.replace(/^command\s*=.*$/mu, 'command = "/bin/false"'), "utf8");
    const badLauncher = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(badLauncher.status).toBe(1);
    expect(JSON.parse(badLauncher.stdout)).toMatchObject({
      config: {
        state: "invalid",
        command: "/bin/false",
        reason: "Codexa-managed command/args do not identify a recognized Codexa launcher"
      }
    });
    expect(Buffer.byteLength(badLauncher.stdout, "utf8")).toBeLessThanOrEqual(4096);

    const mismatchedNpxConfig = config
      .replace(/^command\s*=.*$/mu, 'command = "npx"')
      .replace(
        `args = [${JSON.stringify(cli)}, "serve",`,
        'args = ["-y", "@mirnoorata/codexa@999.999.999", "serve",'
      );
    expect(mismatchedNpxConfig).not.toBe(config);
    await writeFile(configPath, mismatchedNpxConfig, "utf8");
    const mismatchedNpx = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(mismatchedNpx.status).toBe(1);
    expect(JSON.parse(mismatchedNpx.stdout)).toMatchObject({
      implementation: { version: CODEXA_VERSION },
      config: {
        state: "invalid",
        launcher: "@mirnoorata/codexa@999.999.999",
        reason: "Codexa-managed command/args do not identify a recognized Codexa launcher"
      }
    });

    const otherNodeRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-strict-other-node-"));
    const otherNode = path.join(otherNodeRoot, "node");
    const executionSentinel = path.join(otherNodeRoot, "executed");
    await writeFile(
      otherNode,
      `#!/usr/bin/env bash\nprintf executed >${JSON.stringify(executionSentinel)}\nexit 1\n`,
      "utf8"
    );
    await chmod(otherNode, 0o755);
    await writeFile(configPath, config.replaceAll(process.execPath, otherNode), "utf8");
    const incompatibleNode = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(incompatibleNode.status).toBe(1);
    expect(JSON.parse(incompatibleNode.stdout)).toMatchObject({
      config: {
        state: "invalid",
        reason: "Codexa-managed Node command is not the current trusted runtime; re-run codexa init"
      }
    });
    await expect(readFile(executionSentinel, "utf8")).rejects.toThrow();

    const configuredServe = spawnSync(otherNode, [cli, "serve", repo, "--tools", "core"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(configuredServe.status).not.toBe(0);
    expect(await readFile(executionSentinel, "utf8")).toBe("executed");

    const excessiveTools = Array.from({ length: 5000 }, (_, index) => `tool-${index}`);
    await writeFile(
      configPath,
      config.replace(/^enabled_tools\s*=.*$/mu, `enabled_tools = ${JSON.stringify(excessiveTools)}`),
      "utf8"
    );
    const excessive = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(excessive.status).toBe(1);
    expect(JSON.parse(excessive.stdout)).toMatchObject({
      config: { state: "invalid", toolProfile: "unknown" }
    });
    expect(excessive.stdout).not.toContain("tool-4999");
    expect(Buffer.byteLength(excessive.stdout, "utf8")).toBeLessThanOrEqual(4096);

    const serverName = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/mu.exec(config)?.[1];
    expect(serverName).toBeTruthy();
    const invalidManagedConfigs = [
      config.replace('"--tools", "core"]', '"--tools", "core", "--transport", "http"]'),
      config.replace(/^command\s*=/mu, `[mcp_servers.${serverName}.env]\ncommand =`),
      `${config}\n[mcp_servers.${serverName}]\nduplicate = true\n`,
      `${config}\nSTARTUP_RECEIPT_SENTINEL = "unterminated\n`
    ];
    for (const invalidConfig of invalidManagedConfigs) {
      await writeFile(configPath, invalidConfig, "utf8");
      const strict = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      });
      expect(strict.status).toBe(1);
      expect(JSON.parse(strict.stdout)).toMatchObject({ config: { state: "invalid" } });
      expect(strict.stdout).not.toContain("STARTUP_RECEIPT_SENTINEL");
      expect(Buffer.byteLength(strict.stdout, "utf8")).toBeLessThanOrEqual(4096);
    }
  });

  it.skipIf(process.platform === "win32")("attests an empty PATH segment as the current directory without executing it", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const configPath = path.join(repo, ".codex/config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace(/^command\s*=.*$/mu, 'command = "node"'), "utf8");

    const sentinel = path.join(repo, "hostile-node-executed");
    const hostileNode = path.join(repo, "node");
    await writeFile(hostileNode, `#!/bin/sh\nprintf executed >${JSON.stringify(sentinel)}\n`, "utf8");
    await chmod(hostileNode, 0o755);
    const env = testEnv();
    env.PATH = `:${env.PATH ?? ""}`;
    const result = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: repo,
      encoding: "utf8",
      env
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      config: {
        state: "runtime-unverified",
        reason: "Codexa-managed Node command resolves through a runtime shim that cannot be statically attested; strict readiness requires direct host-local wiring"
      }
    });
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();
  });

  it("sanitizes hostile freshness metadata and treats parser errors as nonfresh", async () => {
    const repo = await createHookFixtureRepo();
    expect(
      spawnSync(process.execPath, [cli, "init", repo], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: testEnv()
      }).status
    ).toBe(0);
    const freshnessPath = path.join(repo, ".codex/codebase/freshness.json");
    const integrityPath = path.join(repo, ".codex/codebase/index-integrity.json");
    const originalFreshness = JSON.parse(await readFile(freshnessPath, "utf8")) as Record<string, unknown>;
    const hostileValue = `INDEX-INJECTION\n${"x".repeat(120_000)}`;
    const writeAttestedFreshness = async (freshness: Record<string, unknown>): Promise<void> => {
      const serialized = `${JSON.stringify(freshness, null, 2)}\n`;
      await writeFile(freshnessPath, serialized, "utf8");
      const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
      integrity.freshness = {
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        sha256: createHash("sha256").update(serialized, "utf8").digest("hex")
      };
      await writeFile(integrityPath, `${JSON.stringify(integrity)}\n`, "utf8");
    };

    await writeAttestedFreshness({
      ...originalFreshness,
      reason: hostileValue,
      indexedAt: hostileValue,
      snapshotId: hostileValue
    });
    const hostileJson = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(hostileJson.status).toBe(1);
    expect(JSON.parse(hostileJson.stdout)).toMatchObject({ index: { state: "metadata-invalid" } });
    expect(hostileJson.stdout).not.toContain("INDEX-INJECTION\\n");
    expect(hostileJson.stdout).not.toContain("x".repeat(500));
    expect(Buffer.byteLength(hostileJson.stdout, "utf8")).toBeLessThanOrEqual(4096);

    const hostileText = spawnSync(process.execPath, [cli, "session-start", repo, "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(hostileText.status).toBe(1);
    expect(hostileText.stdout).toContain("Index: metadata-invalid");
    expect(hostileText.stdout).not.toContain("\nINDEX-INJECTION\n");
    expect(Buffer.byteLength(hostileText.stdout, "utf8")).toBeLessThanOrEqual(2048);

    await writeAttestedFreshness({ ...originalFreshness, repoRoot: hostileValue, headCommit: hostileValue });
    const wrongRepo = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(wrongRepo.status).toBe(1);
    expect(JSON.parse(wrongRepo.stdout)).toMatchObject({
      index: { state: "metadata-invalid", repoRoot: repo }
    });
    expect(Buffer.byteLength(wrongRepo.stdout, "utf8")).toBeLessThanOrEqual(4096);

    await writeAttestedFreshness({ ...originalFreshness, parserErrorCount: 1 });
    const parserDegraded = spawnSync(process.execPath, [cli, "session-start", repo, "--json", "--strict"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv()
    });
    expect(parserDegraded.status).toBe(1);
    expect(JSON.parse(parserDegraded.stdout)).toMatchObject({
      index: { state: "parser-degraded", parserErrorCount: 1 }
    });
    expect(parserDegraded.stderr).toContain("index parser-degraded");
    expect(Buffer.byteLength(parserDegraded.stdout, "utf8")).toBeLessThanOrEqual(4096);
  });
});
