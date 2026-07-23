import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject, sessionStartReceipt } from "../src/init.js";

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
