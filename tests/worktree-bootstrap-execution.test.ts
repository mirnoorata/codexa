import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap stage execution", () => {
  it(
    "terminates a stalled stage after its deadline and releases the bootstrap lock",
    async () => {
      const fixture = await createBootstrapExecutionFixture("stall");
      const result = runBootstrapProbe(fixture);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("stage deadline exceeded");
      await expect(stat(path.join(fixture.repo, ".codex/tmp/worktree-bootstrap.log"))).resolves.toMatchObject({
        size: expect.any(Number)
      });
      expect((await stat(path.join(fixture.repo, ".codex/tmp/worktree-bootstrap.log"))).size).toBeLessThanOrEqual(4_096);
      await expect(stat(path.join(fixture.repo, ".codex/tmp/worktree-bootstrap.lock"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      const childPids = (await readFile(fixture.pidPath, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      await Promise.all(childPids.map(expectProcessExit));
    },
      20_000
  );

  it(
    "terminates a noisy stage before the bounded bootstrap log can grow past its cap",
    async () => {
      const fixture = await createBootstrapExecutionFixture("noisy");
      const result = runBootstrapProbe(fixture);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("bounded log output limit exceeded");
      const logPath = path.join(fixture.repo, ".codex/tmp/worktree-bootstrap.log");
      expect((await stat(logPath)).size).toBeLessThanOrEqual(4_096);
      await expect(stat(path.join(fixture.repo, ".codex/tmp/worktree-bootstrap.lock"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      const childPids = (await readFile(fixture.pidPath, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      await Promise.all(childPids.map(expectProcessExit));
    },
      20_000
  );
});

async function createBootstrapExecutionFixture(
  mode: "stall" | "noisy"
): Promise<{ repo: string; fakeBin: string; mode: "stall" | "noisy"; pidPath: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), `codexa-bootstrap-${mode}-`));
  fixtures.push(repo);
  const fakeBin = path.join(repo, "fake-bin");
  const pidPath = path.join(repo, "stage.pid");
  await mkdir(path.join(repo, ".codex/tmp"), { recursive: true });
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  await writeFile(
    path.join(repo, ".codex/worktree-bootstrap.sh"),
    "#!/bin/sh\n# focus-worktree-bootstrap-input: package.json\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: `bootstrap-${mode}`, private: true, scripts: { build: "node -e \"\"" } })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, "package-lock.json"),
    `${JSON.stringify({ name: `bootstrap-${mode}`, lockfileVersion: 3, packages: { "": {} } })}\n`,
    "utf8"
  );
  await writeFile(path.join(repo, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(path.join(repo, ".npmrc"), "audit=false\n", "utf8");
  await writeFile(path.join(repo, "src/index.ts"), "export const fixture = true;\n", "utf8");
  await writeFile(
    path.join(repo, "scripts/worktree-bootstrap-preflight.mjs"),
    await readFile(path.resolve("scripts/worktree-bootstrap-preflight.mjs"), "utf8"),
    "utf8"
  );
  const fakeNpmScript = path.join(fakeBin, "npm-probe.mjs");
  await writeFile(
    fakeNpmScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.env.CODEXA_BOOTSTRAP_TEST_PID_PATH, `${process.pid}\\n${descendant.pid}\\n`);',
      'if (process.env.CODEXA_BOOTSTRAP_TEST_MODE === "stall") {',
      '  process.on("SIGTERM", () => undefined);',
      "  setInterval(() => undefined, 1_000);",
      "} else {",
      '  const chunk = Buffer.alloc(16 * 1024, "x");',
      "  const pump = () => {",
      "    while (process.stdout.write(chunk)) {}",
      '    process.stdout.once("drain", pump);',
      "  };",
      "  pump();",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  const fakeNpm = path.join(fakeBin, "npm");
  await writeFile(fakeNpm, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeNpmScript)} "$@"\n`, "utf8");
  await chmod(fakeNpm, 0o700);
  await writeFile(
    path.join(fakeBin, "npm.cmd"),
    `@echo off\r\n"${process.execPath}" "${fakeNpmScript}" %*\r\n`,
    "utf8"
  );
  return { repo, fakeBin, mode, pidPath };
}

function runBootstrapProbe(fixture: {
  repo: string;
  fakeBin: string;
  mode: "stall" | "noisy";
  pidPath: string;
}): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      path.resolve("scripts/worktree-bootstrap.mjs"),
      process.platform === "win32" ? "native-windows-mcp" : "posix-hooks",
      fixture.repo
    ],
    {
      cwd: fixture.repo,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        CODEXA_BOOTSTRAP_TESTING: "1",
        CODEXA_BOOTSTRAP_TEST_STAGE_TIMEOUT_MS: "250",
        CODEXA_BOOTSTRAP_TEST_TERMINATION_GRACE_MS: "100",
        CODEXA_BOOTSTRAP_TEST_LOG_MAX_BYTES: "4096",
        CODEXA_BOOTSTRAP_TEST_MODE: fixture.mode,
        CODEXA_BOOTSTRAP_TEST_PID_PATH: fixture.pidPath
      }
    }
  );
}

async function expectProcessExit(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`bootstrap stage process ${pid} remained alive after forced termination`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
