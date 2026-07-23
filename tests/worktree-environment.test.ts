import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

describe("tracked Codex worktree environment", () => {
  it("uses explicit POSIX and native-Windows setup lanes", async () => {
    const repoRoot = process.cwd();
    const environmentPath = path.join(repoRoot, ".codex/environments/environment.toml");
    const environment = parseToml(await readFile(environmentPath, "utf8")) as {
      setup?: {
        script?: unknown;
        win32?: { script?: unknown };
      };
    };

    expect(environment.setup?.script).toBe("./.codex/worktree-bootstrap.sh");
    expect(environment.setup?.win32?.script).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -File ./.codex/worktree-bootstrap.ps1"
    );

    const windowsBootstrap = await readFile(path.join(repoRoot, ".codex/worktree-bootstrap.ps1"), "utf8");
    expect(windowsBootstrap).toContain("npm ci --no-audit --no-fund");
    expect(windowsBootstrap).toContain("node dist/cli.js init $repoRoot --tools core --no-hooks");
    expect(windowsBootstrap).toContain("node dist/cli.js session-start $repoRoot --json --strict");
    expect(windowsBootstrap).toContain("bootstrap-receipt=not-issued");
  });
});
