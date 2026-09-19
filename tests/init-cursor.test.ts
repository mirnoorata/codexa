import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeProject } from "../src/init.js";
import { CODEXA_VERSION } from "../src/version.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa cursor ")); roots.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await mkdir(path.join(repo, ".cursor"));
  return repo;
}
const options = { cliPath: "/opt/codexa/dist/cli.js", cursor: true, index: false, hooks: false, serverName: "codexa" };

it("creates portable, idempotent Cursor configuration and preserves other servers and settings", async () => {
  const repo = await fixture();
  const config = path.join(repo, ".cursor/mcp.json");
  const other = { command: "other-server", env: { SETTING: "kept" } };
  await writeFile(config, JSON.stringify({ version: 1, mcpServers: { other } }));
  const result = await initializeProject(repo, options);
  expect(result.cursorMcpPath).toBe(config);
  const first = await readFile(config, "utf8");
  expect(JSON.parse(first)).toEqual({ version: 1, mcpServers: { other, codexa: {
    type: "stdio", command: "npx", args: ["-y", `@mirnoorata/codexa@${CODEXA_VERSION}`, "serve", "${workspaceFolder}", "--auto-refresh", "--tools", "core"]
  } } });
  expect(first).not.toContain(repo);
  expect(first).not.toContain(options.cliPath);
  execFileSync("git", ["add", "-f", ".cursor/mcp.json"], { cwd: repo });
  await initializeProject(repo, options);
  expect(await readFile(config, "utf8")).toBe(first);
});

it("retains a Cursor-only name, profile and environment while updating the launcher", async () => {
  const repo = await fixture(); const config = path.join(repo, ".cursor/mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { custom: { command: "npx", args: ["-y", "@mirnoorata/codexa@0.1.0", "serve", "/old/repo", "--tools", "full"], env: { TYPESAFE_API_KEY: "${env:TYPESAFE_API_KEY}" } } } }));
  const { serverName: _, ...withoutName } = options;
  const result = await initializeProject(repo, withoutName);
  expect(result.serverName).toBe("custom");
  const server = JSON.parse(await readFile(config, "utf8")).mcpServers.custom;
  expect(server.args).toContain("full");
  expect(server.env).toEqual({ TYPESAFE_API_KEY: "${env:TYPESAFE_API_KEY}" });
  expect(server.args).not.toContain("/old/repo");
});

it.each(["{bad", '{"mcpServers": []}', '{"mcpServers":{"codexa":{"command":"unrelated"}}}'])("rejects invalid or conflicting Cursor state before changing Codex wiring: %s", async contents => {
  const repo = await fixture(); const config = path.join(repo, ".cursor/mcp.json");
  await writeFile(config, contents);
  await expect(initializeProject(repo, options)).rejects.toThrow(/Cannot update/);
  expect(await readFile(config, "utf8")).toBe(contents);
  await expect(readFile(path.join(repo, ".codex/config.toml"))).rejects.toThrow();
});

it.each(["symlink", "hardlink", "directory"])("refuses redirected Cursor managed state: %s", async kind => {
  const repo = await fixture(); const target = await fixture();
  const victim = path.join(target, "victim.json"); await writeFile(victim, "{}");
  if (kind === "directory") { await rm(path.join(repo, ".cursor"), { recursive: true }); await symlink(target, path.join(repo, ".cursor")); }
  else if (kind === "symlink") await symlink(victim, path.join(repo, ".cursor/mcp.json"));
  else await link(victim, path.join(repo, ".cursor/mcp.json"));
  await expect(initializeProject(repo, options)).rejects.toThrow(/redirected/);
  expect(await readFile(victim, "utf8")).toBe("{}");
});
