import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Codexa plugin package", () => {
  it("validates the local plugin manifest, MCP config, and skill package", async () => {
    const result = await execFileAsync(process.execPath, ["scripts/verify-plugin-package.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.stdout).toContain("plugin-package: Codexa plugin package passed");
  });

  it("launches the packaged MCP wrapper against the focused git repository", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "codexa-plugin-wrapper-"));
    try {
      const repo = path.join(temp, "repo");
      const packageRoot = path.join(temp, "package");
      const pluginScriptDir = path.join(packageRoot, "plugins", "codexa", "scripts");
      const distDir = path.join(packageRoot, "dist");
      await mkdir(repo, { recursive: true });
      await mkdir(pluginScriptDir, { recursive: true });
      await mkdir(distDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });

      const capturePath = path.join(temp, "capture.json");
      const sourceWrapper = path.join(process.cwd(), "plugins", "codexa", "scripts", "codexa-mcp.js");
      const wrapper = path.join(pluginScriptDir, "codexa-mcp.js");
      await writeFile(wrapper, await readFile(sourceWrapper, "utf8"), "utf8");
      const fakeCli = path.join(distDir, "cli.js");
      await writeFile(
        fakeCli,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync(process.env.CODEXA_PLUGIN_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath }, null, 2));"
        ].join("\n") + "\n",
        "utf8"
      );
      await chmod(fakeCli, 0o755);

      await execFileAsync(process.execPath, [wrapper], {
        cwd: temp,
        env: {
          ...process.env,
          CODEXA_REPO: repo,
          CODEXA_PLUGIN_AUTO_REFRESH: "0",
          CODEXA_PLUGIN_CAPTURE: capturePath
        },
        encoding: "utf8"
      });

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[]; cwd: string; execPath: string };
      expect(capture.cwd).toBe(repo);
      expect(capture.execPath).toBe(process.execPath);
      expect(capture.argv).toEqual(["serve", repo, "--no-auto-refresh"]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("lets the packaged MCP wrapper launch from a custom workspace focus file", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "codexa-plugin-wrapper-focus-"));
    try {
      const workspace = path.join(temp, "workspace");
      const repo = path.join(workspace, "repo");
      const packageRoot = path.join(temp, "package");
      const pluginScriptDir = path.join(packageRoot, "plugins", "codexa", "scripts");
      const distDir = path.join(packageRoot, "dist");
      const focusFile = path.join(temp, "WORKING.md");
      await mkdir(repo, { recursive: true });
      await mkdir(pluginScriptDir, { recursive: true });
      await mkdir(distDir, { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });
      await writeFile(focusFile, `## Active Focus\n\n- Project: \`${repo}\`\n`, "utf8");

      const capturePath = path.join(temp, "capture.json");
      const sourceWrapper = path.join(process.cwd(), "plugins", "codexa", "scripts", "codexa-mcp.js");
      const wrapper = path.join(pluginScriptDir, "codexa-mcp.js");
      await writeFile(wrapper, await readFile(sourceWrapper, "utf8"), "utf8");
      const fakeCli = path.join(distDir, "cli.js");
      await writeFile(
        fakeCli,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync(process.env.CODEXA_PLUGIN_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath }, null, 2));"
        ].join("\n") + "\n",
        "utf8"
      );
      await chmod(fakeCli, 0o755);

      await execFileAsync(process.execPath, [wrapper, workspace], {
        cwd: temp,
        env: {
          ...process.env,
          CODEXA_WORKSPACE_FOCUS_FILE: focusFile,
          CODEXA_PLUGIN_AUTO_REFRESH: "0",
          CODEXA_PLUGIN_CAPTURE: capturePath,
          PWD: workspace
        },
        encoding: "utf8"
      });

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as { argv: string[]; cwd: string; execPath: string };
      expect(capture.cwd).toBe(workspace);
      expect(capture.execPath).toBe(process.execPath);
      expect(capture.argv).toEqual(["serve", workspace, "--no-auto-refresh"]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
