import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { verificationCoverageForCommandReports } from "../src/query/verification.js";

const SEED = 0x5eedc0de;
const GENERATED_CASES = 48;
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("verification shell differential safety", () => {
  let repo = "";
  let binDir = "";
  let invocationLog = "";
  let index: Awaited<ReturnType<typeof buildIndex>>;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "codexa-verification-shell-differential-"));
    binDir = path.join(repo, ".test-bin");
    invocationLog = path.join(repo, ".runner-invocations");
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await mkdir(path.join(repo, "playwright"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify({ name: "shell-differential-fixture", scripts: { "--version": "playwright test tests/generated.test.ts" } }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(repo, "tests/generated.test.ts"), "export const covered = true\n", "utf8");
    const stub = ["#!/bin/sh", "printf '%s\\n' \"${STUB_EXIT:-17}\" >> \"$STUB_LOG\"", "exit \"${STUB_EXIT:-17}\"", ""].join("\n");
    for (const runner of ["vitest", "playwright"]) {
      await writeFile(path.join(binDir, runner), stub, "utf8");
      await chmod(path.join(binDir, runner), 0o755);
    }
    const npxStub = [
      "#!/bin/sh",
      "case \"${1:-}\" in",
      "  --help|--version|-h|-v|-V) exit 0 ;;",
      "esac",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -y|--yes) shift ;;",
      "    -p|--package) shift 2 ;;",
      "    -c|--call) shift; /bin/sh -c \"$1\"; exit $? ;;",
      "    --package=*) shift ;;",
      "    --) shift; break ;;",
      "    *) break ;;",
      "  esac",
      "done",
      "exec \"$@\"",
      ""
    ].join("\n");
    await writeFile(path.join(binDir, "npx"), npxStub, "utf8");
    await chmod(path.join(binDir, "npx"), 0o755);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "shell differential fixture"], {
      cwd: repo,
      stdio: "ignore"
    });
    index = await buildIndex({ repoRoot: repo, writeArtifacts: false });
  });

  afterAll(async () => {
    if (repo) {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects generated masked failures observed through a real shell", async () => {
    for (const [caseIndex, command] of generatedMaskedCommands(SEED, GENERATED_CASES).entries()) {
      const observed = await execute(command);
      expect(observed.invocations, diagnostic(caseIndex, command, observed)).toEqual(["17"]);
      expect(observed.exitCode, diagnostic(caseIndex, command, observed)).toBe(0);

      const coverage = verificationCoverageForCommandReports(index, [], [{ command, cwd: repo, exitCode: observed.exitCode }], repo);
      const positive = coverage.filter((entry) => entry.kind === "javascript-tests" || entry.kind === "targeted-test");
      expect(positive, diagnostic(caseIndex, command, observed)).toEqual([]);
    }
  });

  it("keeps exit-faithful successful runner controls credited", async () => {
    const runners = ["STUB_EXIT=0 vitest run tests/generated.test.ts", "STUB_EXIT=0 playwright test tests/generated.test.ts", "STUB_EXIT=0 npx -y playwright test tests/generated.test.ts"];
    for (const runner of runners) {
      const commands = [runner, `true && ${runner}`, `sh -c ${shellQuote(runner)}`];
      for (const command of commands) {
        const observed = await execute(command);
        expect(observed.invocations, command).toEqual(["0"]);
        expect(observed.exitCode, command).toBe(0);

        const coverage = verificationCoverageForCommandReports(index, [], [{ command, cwd: repo, exitCode: observed.exitCode }], repo);
        expect(coverage.some((entry) => entry.kind === "javascript-tests" && entry.targetPath === "tests/generated.test.ts"), command).toBe(true);
        expect(coverage.some((entry) => entry.kind === "targeted-test" && entry.targetPath === "tests/generated.test.ts"), command).toBe(true);
      }
    }
  });

  it("rejects lookup and launcher metadata modes that execute no runner", async () => {
    const commands = [
      "command -v playwright test tests/generated.test.ts",
      "npx --version playwright test tests/generated.test.ts",
      "npx --help vitest run tests/generated.test.ts",
      "npx -c 'printf metadata >/dev/null' playwright test tests/generated.test.ts",
      "npm run --version",
      "command env --chdir playwright true tests/generated.test.ts",
      "time -o vitest true tests/generated.test.ts"
    ];
    for (const command of commands) {
      const observed = await execute(command);
      expect(observed.invocations, command).toEqual([]);
      expect(observed.exitCode, command).toBe(0);

      const coverage = verificationCoverageForCommandReports(index, [], [{ command, cwd: repo, exitCode: observed.exitCode }], repo);
      expect(coverage.filter((entry) => entry.kind === "javascript-tests" || entry.kind === "targeted-test"), command).toEqual([]);
    }
  });

  async function execute(command: string): Promise<{ exitCode: number | null; invocations: string[]; stderr: string }> {
    await writeFile(invocationLog, "", "utf8");
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        STUB_LOG: invocationLog
      },
      timeout: 2_000
    });
    expect(result.error, command).toBeUndefined();
    const invocations = (await readFile(invocationLog, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return { exitCode: result.status, invocations, stderr: result.stderr };
  }
});

function generatedMaskedCommands(seed: number, count: number): string[] {
  const random = seededRandom(seed);
  const runners = ["STUB_EXIT=17 vitest run tests/generated.test.ts", "STUB_EXIT=17 playwright test tests/generated.test.ts"];
  const masks: Array<(command: string) => string> = [
    (command) => `${command} || true`,
    (command) => `${command}; true`,
    (command) => `${command} | cat >/dev/null`,
    (command) => `${command} & wait $! || true`,
    (command) => `if ${command}; then :; fi`,
    (command) => `while ${command}; do :; done`,
    (command) => `! ${command}`,
    (command) => `${command} && false || true`,
    (command) => `false || ${command} || true`,
    (command) => `echo \"$(${command})\" >/dev/null`
  ];
  const wrappers: Array<(command: string) => string> = [
    (command) => command,
    (command) => `( ${command} )`,
    (command) => `{ ${command}; }`,
    (command) => `sh -c ${shellQuote(command)}`,
    (command) => `sh -c ${shellQuote(`( ${command} )`)}`
  ];
  const prefixes: Array<(command: string) => string> = [
    (command) => command,
    (command) => `:; ${command}`,
    (command) => `printf metadata >/dev/null && ${command}`,
    (command) => `# generated differential case\n${command}`,
    (command) => `cat <<'CODEXA_EOF' >/dev/null\nvitest run tests/decoy.test.ts\nCODEXA_EOF\n${command}`
  ];
  const commands = new Set<string>();
  const seenMasks = new Set<number>();
  const seenWrappers = new Set<number>();
  const seenPrefixes = new Set<number>();
  const seenRunners = new Set<number>();
  let attempts = 0;
  while (commands.size < count) {
    attempts += 1;
    if (attempts > 10_000) {
      throw new Error(`seed ${seed} could not generate ${count} unique differential commands`);
    }
    const maskIndex = randomIndex(random, masks.length);
    const wrapperIndex = randomIndex(random, wrappers.length);
    const prefixIndex = randomIndex(random, prefixes.length);
    const runnerIndex = randomIndex(random, runners.length);
    const mask = masks[maskIndex];
    const wrapper = wrappers[wrapperIndex];
    const prefix = prefixes[prefixIndex];
    commands.add(prefix(wrapper(mask(runners[runnerIndex]))));
    seenMasks.add(maskIndex);
    seenWrappers.add(wrapperIndex);
    seenPrefixes.add(prefixIndex);
    seenRunners.add(runnerIndex);
  }
  if (seenMasks.size !== masks.length || seenWrappers.size !== wrappers.length || seenPrefixes.size !== prefixes.length || seenRunners.size !== runners.length) {
    throw new Error(`seed ${seed} did not cover every differential command dimension`);
  }
  return [...commands];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function randomIndex(random: () => number, length: number): number {
  return Math.floor((random() / 0x1_0000_0000) * length);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function diagnostic(caseIndex: number, command: string, observed: { exitCode: number | null; invocations: string[]; stderr: string }): string {
  return `seed=${SEED} case=${caseIndex} command=${JSON.stringify(command)} exit=${String(observed.exitCode)} invocations=${JSON.stringify(observed.invocations)} stderr=${JSON.stringify(observed.stderr)}`;
}
