import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpRuntime } from "../src/mcp/runtime.js";

describe("MCP default focus-file safety", () => {
  it.each(["symlink", "hardlink"] as const)(
    "refuses a redirected %s default focus file in the production MCP runtime",
    async (kind) => {
      const workspace = await createRepo(`codexa-mcp-focus-${kind}-`);
      const nestedRepo = await createNestedRepo(workspace);
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), `codexa-mcp-focus-${kind}-target-`));
      const victim = path.join(externalRoot, "WORKING.md");
      const original = `Focused project: \`${nestedRepo}\`\n`;
      await writeFile(victim, original, "utf8");
      await mkdir(path.join(workspace, ".codex"), { recursive: true });
      const defaultFocus = path.join(workspace, ".codex", "WORKING.md");
      if (kind === "symlink") await symlink(victim, defaultFocus);
      else await link(victim, defaultFocus);

      const runtime = createMcpRuntime({
        configuredRepoRoot: workspace,
        queryOptions: { autoRefresh: true }
      });

      await expect(runtime.resolveActiveRepoRootResolution()).rejects.toThrow(
        /refuses redirected or non-regular managed file/u
      );
      expect(await readFile(victim, "utf8")).toBe(original);
    }
  );

  it("uses an explicit safe focus file without inspecting an unsafe managed default", async () => {
    const workspace = await createRepo("codexa-mcp-explicit-focus-");
    const nestedRepo = await createNestedRepo(workspace);
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-mcp-explicit-focus-target-"));
    const victim = path.join(externalRoot, "WORKING.md");
    await writeFile(victim, `Focused project: \`${workspace}\`\n`, "utf8");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await symlink(victim, path.join(workspace, ".codex", "WORKING.md"));
    const explicitFocus = path.join(workspace, "safe-focus.md");
    await writeFile(explicitFocus, `Focused project: \`${nestedRepo}\`\n`, "utf8");

    const runtime = createMcpRuntime({
      configuredRepoRoot: workspace,
      queryOptions: { autoRefresh: false, workspaceFocusFile: explicitFocus }
    });

    await expect(runtime.resolveActiveRepoRootResolution()).resolves.toMatchObject({
      configuredRoot: workspace,
      repoRoot: nestedRepo,
      source: "workspace-focus-file",
      focusFile: explicitFocus,
      focusReason: "explicit-focus"
    });
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}

async function createNestedRepo(workspace: string): Promise<string> {
  const repo = path.join(workspace, "nested-repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(path.join(repo, "README.md"), "# nested fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "nested fixture"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}
