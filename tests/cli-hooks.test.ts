import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
});
