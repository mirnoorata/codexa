import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type InitPortabilityModule = typeof import("../src/init-portability.js");

const concurrentWrite = vi.hoisted(() => ({
  hooksPath: "",
  replacement: "",
  injected: false
}));

vi.mock("../src/init-portability.js", async (importOriginal) => {
  const actual = await importOriginal() as InitPortabilityModule;
  return {
    ...actual,
    writeTextIfChanged: async (filePath: string, existing: string, contents: string) => {
      if (filePath === concurrentWrite.hooksPath && !concurrentWrite.injected) {
        concurrentWrite.injected = true;
        const { writeFile: writeConcurrentFile } = await import("node:fs/promises");
        await writeConcurrentFile(filePath, concurrentWrite.replacement, "utf8");
      }
      return actual.writeTextIfChanged(filePath, existing, contents);
    }
  };
});

const { initializeProject } = await import("../src/init.js");

describe("init --no-hooks conflict ordering", () => {
  it("does not disable a user hook added after Codexa plans managed-hook removal", async () => {
    const repo = await createRepo("codexa-init-no-hooks-conflict-");
    const codexDir = path.join(repo, ".codex");
    const configPath = path.join(codexDir, "config.toml");
    const hooksPath = path.join(codexDir, "hooks.json");
    await mkdir(codexDir, { recursive: true });
    const originalConfig = "[features]\nhooks = true\n";
    await writeFile(configPath, originalConfig, "utf8");
    await writeFile(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          SessionStart: [{
            codexaManaged: true,
            matcher: "startup|resume",
            hooks: [{ codexaManaged: true, type: "command", command: "node /opt/codexa/dist/cli.js session-start" }]
          }]
        }
      }, null, 2)}\n`,
      "utf8"
    );
    const userHooks = `${JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup",
          hooks: [{ type: "command", command: "echo user-hook" }]
        }]
      }
    }, null, 2)}\n`;
    concurrentWrite.hooksPath = hooksPath;
    concurrentWrite.replacement = userHooks;
    concurrentWrite.injected = false;

    await expect(
      initializeProject(repo, {
        cliPath: path.resolve("dist/cli.js"),
        hooks: false,
        index: false
      })
    ).rejects.toThrow(/file changed while Codexa was preparing the update/u);

    expect(concurrentWrite.injected).toBe(true);
    expect(await readFile(hooksPath, "utf8")).toBe(userHooks);
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
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
