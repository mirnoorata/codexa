import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/init.js";

describe("Codexa MCP config coexistence", () => {
  it("preserves Graphify when its executable path happens to mention Codexa", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-init-graphify-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, ".codex"), { recursive: true });
      const graphifyPython = "/tmp/codexa-graphify/venv/bin/python";
      await writeFile(path.join(repo, ".codex/config.toml"), [
        "[features]",
        "hooks = true",
        "",
        "[mcp_servers.graphify]",
        `command = ${JSON.stringify(graphifyPython)}`,
        `args = ["-m", "graphify.serve", ${JSON.stringify(path.join(repo, "graphify-out/graph.json"))}]`,
        ""
      ].join("\n"), "utf8");

      await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });
      await initializeProject(repo, { cliPath: "/opt/codexa/dist/cli.js", index: false });
      const config = await readFile(path.join(repo, ".codex/config.toml"), "utf8");
      expect(config).toContain("[mcp_servers.graphify]");
      expect(config).toContain(`command = ${JSON.stringify(graphifyPython)}`);
      expect(config.match(/\[mcp_servers\.graphify\]/gu)).toHaveLength(1);
      expect(config.match(/# >>> codexa managed/gu)).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
