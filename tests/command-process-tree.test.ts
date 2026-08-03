import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/command.js";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("runCommand process-tree termination", () => {
  it("returns promptly when the process group accepts SIGTERM", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexa-command-cooperative-tree-"));
    fixtures.push(directory);
    const pidPath = path.join(directory, "processes.pid");
    const script = path.join(directory, "spawn-cooperative-child.mjs");
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });',
        `writeFileSync(${JSON.stringify(pidPath)}, \`\${process.pid}\\n\${child.pid}\\n\`);`,
        "setInterval(() => undefined, 1000);"
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = await runCommand(process.execPath, [script], {
      killProcessGroup: true,
      timeoutMs: 150,
      maxBufferBytes: 16 * 1024
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    const pids = (await readFile(pidPath, "utf8")).trim().split("\n").map(Number);
    await Promise.all(pids.map(expectProcessExit));
  }, 5_000);

  it("forces a resistant descendant to exit after the direct child closes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexa-command-tree-"));
    fixtures.push(directory);
    const pidPath = path.join(directory, "processes.pid");
    const script = path.join(directory, "spawn-child.mjs");
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" });',
        `writeFileSync(${JSON.stringify(pidPath)}, \`\${process.pid}\\n\${child.pid}\\n\`);`,
        "setInterval(() => undefined, 1000);"
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = await runCommand(process.execPath, [script], {
      killProcessGroup: true,
      timeoutMs: 150,
      maxBufferBytes: 16 * 1024
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(12_000);

    const pids = (await readFile(pidPath, "utf8")).trim().split("\n").map(Number);
    await Promise.all(pids.map(expectProcessExit));
  }, 15_000);

  it("settles a direct timeout when an escaped descendant retains its pipes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexa-command-pipe-"));
    fixtures.push(directory);
    const pidPath = path.join(directory, "processes.pid");
    const script = path.join(directory, "escape-child.mjs");
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
        "child.unref();",
        `writeFileSync(${JSON.stringify(pidPath)}, \`\${process.pid}\\n\${child.pid}\\n\`);`
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = await runCommand(process.execPath, [script], {
      // This case validates post-timeout settlement when a detached descendant
      // retains inherited pipes. Leave enough time for the fixture's nested
      // Node process to start even while other integration workers are active.
      timeoutMs: 1_000,
      maxBufferBytes: 16 * 1024
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    const pids = (await readFile(pidPath, "utf8")).trim().split("\n").map(Number);
    await expectProcessExit(pids[0]);
    await forceProcessExit(pids[1]);
  }, 10_000);
});

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
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may have exited at the assertion boundary.
  }
  throw new Error(`command process ${pid} remained alive after forced tree termination`);
}

async function forceProcessExit(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await expectProcessExit(pid);
}
