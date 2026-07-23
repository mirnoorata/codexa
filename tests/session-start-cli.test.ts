import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEXA_VERSION } from "../src/version.js";
import { createHookFixtureRepo, testEnv } from "./cli-hooks-fixtures.js";

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
      schemaVersion: 1,
      kind: "codexa-session-start",
      availability: "ok",
      repoRoot: repo,
      config: { state: "not-configured", toolProfile: "unknown" },
      index: { state: "missing" },
      threadMcp: { state: "unverified", reason: "session-start-cannot-observe-host-initialize" }
    });
    const latest = JSON.parse(
      await readFile(path.join(repo, ".codex/cache/codexa-hooks/latest.json"), "utf8")
    ) as { status: string; error?: string };
    expect(latest).toMatchObject({ status: "ok" });
    expect(latest.error).toBeUndefined();

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
    const indexPath = path.join(repo, ".codex/codebase/index.json");
    const original = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    const originalFreshness = original.freshness as Record<string, unknown>;
    const hostileValue = `INDEX-INJECTION\n${"x".repeat(120_000)}`;

    await writeFile(
      indexPath,
      `${JSON.stringify({
        ...original,
        freshness: {
          ...originalFreshness,
          reason: hostileValue,
          indexedAt: hostileValue,
          snapshotId: hostileValue
        }
      })}\n`,
      "utf8"
    );
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

    await writeFile(
      indexPath,
      `${JSON.stringify({
        ...original,
        freshness: { ...originalFreshness, repoRoot: hostileValue, headCommit: hostileValue }
      })}\n`,
      "utf8"
    );
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

    await writeFile(
      indexPath,
      `${JSON.stringify({
        ...original,
        freshness: { ...originalFreshness, parserErrorCount: 1 }
      })}\n`,
      "utf8"
    );
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
