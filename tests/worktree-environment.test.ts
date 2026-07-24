import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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

    const posixBootstrap = await readFile(path.join(repoRoot, ".codex/worktree-bootstrap.sh"), "utf8");
    const trackedBootstrap = execFileSync(
      "git",
      ["ls-files", "--stage", "--", ".codex/worktree-bootstrap.sh"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(trackedBootstrap).toMatch(/^100755 /u);
    if (process.platform !== "win32") {
      const posixBootstrapStat = await stat(path.join(repoRoot, ".codex/worktree-bootstrap.sh"));
      expect(posixBootstrapStat.mode & 0o111).not.toBe(0);
    }
    expect(posixBootstrap).toContain('"$repo_root/scripts/worktree-bootstrap.mjs" posix-hooks "$repo_root"');
    expect(posixBootstrap).not.toContain("npm ci");
    expect(posixBootstrap).not.toContain("worktree-receipt issue");
    expect(posixBootstrap).not.toContain("git rev-parse");

    const windowsBootstrap = await readFile(path.join(repoRoot, ".codex/worktree-bootstrap.ps1"), "utf8");
    expect(windowsBootstrap).toContain('"scripts/worktree-bootstrap.mjs") native-windows-mcp $repoRoot');
    expect(windowsBootstrap).not.toContain("npm ci");
    expect(windowsBootstrap).not.toContain("worktree-receipt issue");
    expect(windowsBootstrap).not.toContain("git rev-parse");

    const orchestrator = await readFile(path.join(repoRoot, "scripts/worktree-bootstrap.mjs"), "utf8");
    expect(orchestrator).toContain("acquireBootstrapLock");
    expect(orchestrator).toContain("scripts/worktree-bootstrap-preflight.mjs");
    expect(orchestrator).toContain('npmInvocation(["ci", "--no-audit", "--no-fund"])');
    expect(orchestrator).toContain('"--expected-build-input"');
    expect(orchestrator).toContain('"--expected-startup-input"');
    expect(orchestrator).toContain("receipt: 5 * 60_000");
    expect(orchestrator.indexOf("expectedStartupInput = await hashStartupInputs")).toBeLessThan(
      orchestrator.indexOf('npmInvocation(["ci", "--no-audit", "--no-fund"])')
    );
    expect(orchestrator.indexOf('"Codexa worktree receipt"')).toBeLessThan(
      orchestrator.indexOf('"Codexa strict startup check"')
    );

    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["benchmark:ci"]).toContain("--strict-session-start");
    expect(packageJson.scripts?.["benchmark:ci"]).toContain("--verify-startup-contract");

    const workflow = await readFile(path.join(repoRoot, ".github/workflows/check.yml"), "utf8");
    expect(workflow).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(workflow).not.toContain("worktree-bootstrap-macos-lock:");
    expect(workflow).toContain("git worktree add --detach ../codexa-linked-worktree HEAD");
    expect(workflow).toContain(
      "powershell -NoProfile -ExecutionPolicy Bypass -File ./.codex/worktree-bootstrap.ps1"
    );
    expect(workflow).toContain("working-directory: ../codexa-linked-worktree");
    expect(workflow.indexOf("Run post-bootstrap test smoke")).toBeLessThan(
      workflow.indexOf("Validate consumed setup receipt")
    );

    const vitestConfig = await readFile(path.join(repoRoot, "vitest.config.cts"), "utf8");
    expect(vitestConfig).toContain('cacheDir: ".codex/cache/vite"');
  });
});
