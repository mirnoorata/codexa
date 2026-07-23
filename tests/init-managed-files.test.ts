import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, sessionStartReceipt } from "../src/init.js";
import { writeTextIfChanged } from "../src/init-portability.js";

const cliPath = path.resolve(process.cwd(), "dist/cli.js");

describe("Codexa managed startup files", () => {
  it("refuses a redirected config without reading or changing its target", async () => {
    const repo = await createRepo("codexa-init-config-link-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-config-target-"));
    const victim = path.join(externalRoot, "config.toml");
    const original = "[features]\nhooks = false\n";
    await writeFile(victim, original, "utf8");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await symlink(victim, path.join(repo, ".codex/config.toml"));

    await expect(
      initializeProject(repo, { cliPath, hooks: false, index: false })
    ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
    expect(await readFile(victim, "utf8")).toBe(original);

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({
      state: "invalid",
      reason: expect.stringMatching(/refuses redirected or non-regular managed file/u)
    });
    expect(await readFile(victim, "utf8")).toBe(original);
  });

  it("refuses redirected hook wiring without changing its target", async () => {
    const repo = await createRepo("codexa-init-hooks-link-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-hooks-target-"));
    const victim = path.join(externalRoot, "hooks.json");
    const original = `${JSON.stringify({ hooks: { custom: [] } }, null, 2)}\n`;
    await writeFile(victim, original, "utf8");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await symlink(victim, path.join(repo, ".codex/hooks.json"));

    await expect(
      initializeProject(repo, { cliPath, index: false })
    ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
    expect(await readFile(victim, "utf8")).toBe(original);
  });

  it("refuses a multi-link config instead of mutating the shared inode", async () => {
    const repo = await createRepo("codexa-init-config-hardlink-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-hardlink-target-"));
    const victim = path.join(externalRoot, "config.toml");
    const original = "[features]\nhooks = false\n";
    await writeFile(victim, original, "utf8");
    await mkdir(path.join(repo, ".codex"), { recursive: true });
    await link(victim, path.join(repo, ".codex/config.toml"));

    await expect(
      initializeProject(repo, { cliPath, hooks: false, index: false })
    ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
    expect(await readFile(victim, "utf8")).toBe(original);
  });

  it("refuses a redirected managed-state directory", async () => {
    const repo = await createRepo("codexa-init-directory-link-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-directory-target-"));
    await symlink(externalRoot, path.join(repo, ".codex"), "dir");

    await expect(
      initializeProject(repo, { cliPath, hooks: false, index: false })
    ).rejects.toThrow(/refuses redirected or non-directory managed state/u);
  });

  it("refuses a redirected AGENTS.md without changing its target", async () => {
    const repo = await createRepo("codexa-init-agents-link-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-agents-target-"));
    const victim = path.join(externalRoot, "AGENTS.md");
    const original = "# External instructions\n";
    await writeFile(victim, original, "utf8");
    await symlink(victim, path.join(repo, "AGENTS.md"));

    await expect(
      initializeProject(repo, { cliPath, agentsMd: true, hooks: false, index: false })
    ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
    expect(await readFile(victim, "utf8")).toBe(original);
  });

  it("refuses a multi-link CLAUDE.md without changing its shared inode", async () => {
    const repo = await createRepo("codexa-init-claude-hardlink-");
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-init-claude-target-"));
    const victim = path.join(externalRoot, "CLAUDE.md");
    const original = "# External instructions\n";
    await writeFile(victim, original, "utf8");
    await link(victim, path.join(repo, "CLAUDE.md"));

    await expect(
      initializeProject(repo, { cliPath, claudeMd: true, hooks: false, index: false })
    ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
    expect(await readFile(victim, "utf8")).toBe(original);
  });

  it("rejects a stale caller snapshot before replacing a managed file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexa-init-concurrent-write-"));
    const managedPath = path.join(root, "config.toml");
    await writeFile(managedPath, "original\n", "utf8");
    await writeFile(managedPath, "user edit\n", "utf8");

    await expect(
      writeTextIfChanged(managedPath, "original\n", "codexa update\n")
    ).rejects.toThrow(/file changed while Codexa was preparing the update/u);
    expect(await readFile(managedPath, "utf8")).toBe("user edit\n");
  });

  it("preserves an existing managed file mode across atomic replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexa-init-file-mode-"));
    const managedPath = path.join(root, "config.toml");
    await writeFile(managedPath, "original\n", "utf8");
    await chmod(managedPath, 0o664);
    const expectedMode = (await stat(managedPath)).mode & 0o777;
    const originalUmask = process.umask(0o077);
    try {
      await writeTextIfChanged(managedPath, "original\n", "codexa update\n");
    } finally {
      process.umask(originalUmask);
    }

    expect((await stat(managedPath)).mode & 0o777).toBe(expectedMode);
    expect(await readFile(managedPath, "utf8")).toBe("codexa update\n");
  });

  it("refuses redirected and multi-link Claude MCP configuration", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const repo = await createRepo(`codexa-init-mcp-${kind}-`);
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), `codexa-init-mcp-${kind}-target-`));
      const victim = path.join(externalRoot, ".mcp.json");
      const original = "{}\n";
      await writeFile(victim, original, "utf8");
      if (kind === "symlink") await symlink(victim, path.join(repo, ".mcp.json"));
      else await link(victim, path.join(repo, ".mcp.json"));

      await expect(
        initializeProject(repo, { cliPath, claude: true, hooks: false, index: false })
      ).rejects.toThrow(/refuses redirected or non-regular managed file/u);
      expect(await readFile(victim, "utf8")).toBe(original);
    }
  });

  it("does not attest config through a redirected managed-state directory", async () => {
    const repo = await createRepo("codexa-session-directory-link-");
    await initializeProject(repo, { cliPath, hooks: false, index: false });
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codexa-session-directory-target-"));
    const codexDir = path.join(repo, ".codex");
    const movedCodexDir = path.join(externalRoot, "managed-state");
    await rename(codexDir, movedCodexDir);
    await symlink(movedCodexDir, codexDir, "dir");

    const receipt = await sessionStartReceipt(repo, false);
    expect(receipt.config).toMatchObject({
      state: "invalid",
      reason: expect.stringMatching(/refuses redirected or non-directory managed state/u)
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
