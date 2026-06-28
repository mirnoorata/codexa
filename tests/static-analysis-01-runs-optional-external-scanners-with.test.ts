import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { impactQuery } from "../src/query/impact.js";
import { symbolContextQuery } from "../src/query/inspection.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
describe("static-analysis scanner runners", () => {
it("runs optional external scanners with a scrubbed environment", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-runner-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");

    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-bin-"));
    const envLog = path.join(repo, "scanner-env.json");
    const fakeSemgrep = path.join(binDir, "semgrep");
    await writeFile(
      fakeSemgrep,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const outputIndex = process.argv.indexOf('--json-output');",
        "if (outputIndex === -1) process.exit(2);",
        "fs.mkdirSync(require('node:path').dirname(process.argv[outputIndex + 1]), { recursive: true });",
        "fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ results: [] }));",
        `fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
        "  leaked: process.env.CODEXA_SECRET_FIXTURE || null,",
        "  prompt: process.env.GIT_TERMINAL_PROMPT || null,",
        "  marker: process.env.CODEXA_EXTERNAL_SCANNER || null",
        "}));"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeSemgrep, 0o755);

    const oldPath = process.env.PATH;
    const oldSecret = process.env.CODEXA_SECRET_FIXTURE;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    process.env.CODEXA_SECRET_FIXTURE = "do-not-forward-this-value";
    try {
      const result = await updateStaticAnalysisReports(repo, {
        runSemgrep: true,
        semgrepConfigs: ["p/default"],
        index: false,
        timeoutMs: 5_000
      });
      const scannerEnv = JSON.parse(await readFile(envLog, "utf8")) as { leaked: string | null; prompt: string | null; marker: string | null };

      expect(result.runs[0]?.tool).toBe("semgrep");
      expect(scannerEnv.leaked).toBeNull();
      expect(scannerEnv.prompt).toBe("0");
      expect(scannerEnv.marker).toBe("1");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      if (oldSecret === undefined) {
        delete process.env.CODEXA_SECRET_FIXTURE;
      } else {
        process.env.CODEXA_SECRET_FIXTURE = oldSecret;
      }
    }
  });

it("runs ShellCheck and converts findings into Codexa risks", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-shellcheck-"));
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(path.join(repo, "scripts/test.sh"), "#!/usr/bin/env bash\necho $value\n", "utf8");

    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-shellcheck-bin-"));
    const fakeShellcheck = path.join(binDir, "shellcheck");
    await writeFile(
      fakeShellcheck,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--format=json')) process.exit(2);",
        "const file = args[args.length - 1];",
        "process.stdout.write(JSON.stringify({ comments: [{ file, line: 2, level: 'warning', code: 2086, message: 'Double quote to prevent globbing and word splitting.' }] }));",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeShellcheck, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      const result = await updateStaticAnalysisReports(repo, {
        runShellcheck: true,
        index: false,
        timeoutMs: 5_000
      });
      const shellcheckReport = result.reports.find((report) => report.kind === "shellcheck");
      expect(shellcheckReport?.path).toBe(".codex/static-analysis/shellcheck.json");
      expect(result.runs[0]?.tool).toBe("shellcheck");
      expect(result.staticRiskCount).toBe(1);

      const report = JSON.parse(await readFile(path.join(repo, ".codex/static-analysis/shellcheck.json"), "utf8")) as {
        risks: Array<{ path: string; signal: string; severity: string; confidence: string; line: number; reason: string }>;
      };
      expect(report.risks[0]).toMatchObject({
        path: "scripts/test.sh",
        signal: "shellcheck.SC2086",
        severity: "WARNING",
        confidence: "authoritative",
        line: 2
      });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("drops ShellCheck findings whose reported paths resolve outside the repository", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-shellcheck-escape-"));
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(path.join(repo, "scripts/test.sh"), "#!/usr/bin/env bash\necho $value\n", "utf8");

    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-shellcheck-escape-bin-"));
    const fakeShellcheck = path.join(binDir, "shellcheck");
    await writeFile(
      fakeShellcheck,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--format=json')) process.exit(2);",
        "process.stdout.write(JSON.stringify({ comments: [{ file: 'src/../../outside.sh', line: 1, level: 'warning', code: 2086, message: 'outside' }] }));",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeShellcheck, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      const result = await updateStaticAnalysisReports(repo, {
        runShellcheck: true,
        index: false,
        timeoutMs: 5_000
      });
      expect(result.staticRiskCount).toBe(0);
      const report = JSON.parse(await readFile(path.join(repo, ".codex/static-analysis/shellcheck.json"), "utf8")) as { risks: unknown[] };
      expect(report.risks).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("reports missing optional scanner binaries explicitly", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-missing-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    await writeFile(path.join(repo, "test.sh"), "echo hi\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-empty-bin-"));
    const oldPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runSemgrep: true,
          index: false,
          timeoutMs: 1_000
        })
      ).rejects.toThrow("semgrep is not installed or not on PATH");

      await expect(
        updateStaticAnalysisReports(repo, {
          runCodeql: true,
          index: false,
          timeoutMs: 1_000
        })
      ).rejects.toThrow("codeql is not installed or not on PATH");

      await expect(
        updateStaticAnalysisReports(repo, {
          runShellcheck: true,
          index: false,
          timeoutMs: 1_000
        })
      ).rejects.toThrow("shellcheck is not installed or not on PATH");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("kills timed-out external scanner process groups and removes partial output", async () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-timeout-group-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-timeout-bin-"));
    const marker = path.join(repo, "leaked-child.txt");
    const fakeSemgrep = path.join(binDir, "semgrep");
    await writeFile(
      fakeSemgrep,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const args = process.argv.slice(2);",
        "const output = args[args.indexOf('--json-output') + 1];",
        "if (output) fs.writeFileSync(output, '{\"partial\"');",
        `spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 700); setTimeout(() => {}, 2000);`)}], { stdio: "ignore" });`,
        "setTimeout(() => {}, 2000);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeSemgrep, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runSemgrep: true,
          index: false,
          timeoutMs: 100
        })
      ).rejects.toThrow(/semgrep timed out/);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await expect(readFile(marker, "utf8")).rejects.toThrow();
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry === "semgrep.json" || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("does not publish invalid Semgrep JSON after a successful scanner exit", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-semgrep-invalid-json-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-semgrep-invalid-json-bin-"));
    const fakeSemgrep = path.join(binDir, "semgrep");
    await writeFile(
      fakeSemgrep,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const output = args[args.indexOf('--json-output') + 1];",
        "fs.mkdirSync(path.dirname(output), { recursive: true });",
        "fs.writeFileSync(output, '{bad');",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeSemgrep, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runSemgrep: true,
          index: false,
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/Semgrep JSON report is not valid JSON/);
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry === "semgrep.json" || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("does not publish scanner temp symlinks after a successful scanner exit", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-semgrep-temp-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-semgrep-temp-symlink-target-"));
    await writeFile(path.join(outside, "semgrep.json"), JSON.stringify({ results: [] }), "utf8");
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-semgrep-temp-symlink-bin-"));
    const fakeSemgrep = path.join(binDir, "semgrep");
    await writeFile(
      fakeSemgrep,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const output = args[args.indexOf('--json-output') + 1];",
        "fs.mkdirSync(path.dirname(output), { recursive: true });",
        `fs.symlinkSync(${JSON.stringify(path.join(outside, "semgrep.json"))}, output);`,
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeSemgrep, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runSemgrep: true,
          index: false,
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/Semgrep JSON report is not valid JSON/);
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry === "semgrep.json" || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("does not publish partial CodeQL reports when one language analysis fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-partial-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-bin-"));
    const fakeCodeql = path.join(binDir, "codeql");
    await writeFile(
      fakeCodeql,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'database' && args[1] === 'create') {",
        "  const dbRoot = args[2];",
        "  fs.mkdirSync(path.join(dbRoot, 'javascript-typescript'), { recursive: true });",
        "  fs.mkdirSync(path.join(dbRoot, 'python'), { recursive: true });",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'database' && args[1] === 'analyze') {",
        "  const outputArg = args.find((arg) => arg.startsWith('--output='));",
        "  const output = outputArg ? outputArg.slice('--output='.length) : undefined;",
        "  if (args[2].endsWith('javascript-typescript')) {",
        "    fs.mkdirSync(path.dirname(output), { recursive: true });",
        "    fs.writeFileSync(output, JSON.stringify({ version: '2.1.0', runs: [] }));",
        "    process.exit(0);",
        "  }",
        "  if (output) fs.writeFileSync(output, '{\"partial\"');",
        "  process.stderr.write('python analysis failed');",
        "  process.exit(2);",
        "}",
        "process.exit(2);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodeql, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runCodeql: true,
          codeqlLanguages: ["javascript-typescript", "python"],
          index: false,
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/codeql failed/);
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry.startsWith("codeql-") || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("does not publish invalid CodeQL SARIF after a successful scanner exit", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-invalid-sarif-"));
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-invalid-sarif-bin-"));
    const fakeCodeql = path.join(binDir, "codeql");
    await writeFile(
      fakeCodeql,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'database' && args[1] === 'create') {",
        "  fs.mkdirSync(path.join(args[2], 'javascript-typescript'), { recursive: true });",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'database' && args[1] === 'analyze') {",
        "  const outputArg = args.find((arg) => arg.startsWith('--output='));",
        "  const output = outputArg ? outputArg.slice('--output='.length) : undefined;",
        "  fs.mkdirSync(path.dirname(output), { recursive: true });",
        "  fs.writeFileSync(output, '{bad');",
        "  process.exit(0);",
        "}",
        "process.exit(2);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodeql, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runCodeql: true,
          codeqlLanguages: ["javascript-typescript"],
          index: false,
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/SARIF report is not valid JSON/);
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry.startsWith("codeql-") || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("prunes stale CodeQL language reports after a narrowed successful run", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-stale-language-"));
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, ".codex/static-analysis/codeql-python.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ stale: true }], properties: { generatedBy: "codexa-codeql-runner" } }), "utf8");
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-stale-language-bin-"));
    const fakeCodeql = path.join(binDir, "codeql");
    await writeFile(
      fakeCodeql,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'database' && args[1] === 'create') {",
        "  fs.mkdirSync(path.join(args[2], 'javascript-typescript'), { recursive: true });",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'database' && args[1] === 'analyze') {",
        "  const outputArg = args.find((arg) => arg.startsWith('--output='));",
        "  const output = outputArg ? outputArg.slice('--output='.length) : undefined;",
        "  fs.mkdirSync(path.dirname(output), { recursive: true });",
        "  fs.writeFileSync(output, JSON.stringify({ version: '2.1.0', runs: [] }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodeql, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      const result = await updateStaticAnalysisReports(repo, {
        runCodeql: true,
        codeqlLanguages: ["javascript-typescript"],
        index: false,
        timeoutMs: 5_000
      });
      expect(result.reports.map((report) => report.path)).toContain(".codex/static-analysis/codeql-javascript.sarif");
      await expect(readFile(path.join(repo, ".codex/static-analysis/codeql-python.sarif"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(repo, ".codex/static-analysis/codeql-javascript.sarif"), "utf8")).resolves.toContain('"runs"');
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("preserves user-managed CodeQL reports during narrowed generated cleanup", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-preserve-user-"));
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, ".codex/static-analysis/codeql-python.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ userManaged: true }] }), "utf8");
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-preserve-user-bin-"));
    const fakeCodeql = path.join(binDir, "codeql");
    await writeFile(
      fakeCodeql,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'database' && args[1] === 'create') {",
        "  fs.mkdirSync(path.join(args[2], 'javascript-typescript'), { recursive: true });",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'database' && args[1] === 'analyze') {",
        "  const outputArg = args.find((arg) => arg.startsWith('--output='));",
        "  const output = outputArg ? outputArg.slice('--output='.length) : undefined;",
        "  fs.mkdirSync(path.dirname(output), { recursive: true });",
        "  fs.writeFileSync(output, JSON.stringify({ version: '2.1.0', runs: [] }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodeql, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await updateStaticAnalysisReports(repo, {
        runCodeql: true,
        codeqlLanguages: ["javascript-typescript"],
        index: false,
        timeoutMs: 5_000
      });
      await expect(readFile(path.join(repo, ".codex/static-analysis/codeql-python.sarif"), "utf8")).resolves.toContain("userManaged");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("rolls back CodeQL reports when final publish fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-publish-"));
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis/codeql-python.sarif"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    const binDir = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-codeql-publish-bin-"));
    const fakeCodeql = path.join(binDir, "codeql");
    await writeFile(
      fakeCodeql,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'database' && args[1] === 'create') {",
        "  const dbRoot = args[2];",
        "  fs.mkdirSync(path.join(dbRoot, 'javascript-typescript'), { recursive: true });",
        "  fs.mkdirSync(path.join(dbRoot, 'python'), { recursive: true });",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'database' && args[1] === 'analyze') {",
        "  const outputArg = args.find((arg) => arg.startsWith('--output='));",
        "  const output = outputArg ? outputArg.slice('--output='.length) : undefined;",
        "  fs.mkdirSync(path.dirname(output), { recursive: true });",
        "  fs.writeFileSync(output, JSON.stringify({ version: '2.1.0', runs: [] }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodeql, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(
        updateStaticAnalysisReports(repo, {
          runCodeql: true,
          codeqlLanguages: ["javascript-typescript", "python"],
          index: false,
          timeoutMs: 5_000
        })
      ).rejects.toThrow(/destination is not a file/);
      const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
      expect(generatedFiles.filter((entry) => entry === "codeql-javascript.sarif" || entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }
  });

it("imports bounded external symbol reports into degraded symbol context and impact", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-report-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn start_server() {}\n", "utf8");
    await writeFile(path.join(repo, "src/main.rs"), "fn main() { crate::start_server(); }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const reportPath = path.join(repo, "reports", "symbols-source.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          tool: "fixture-symbol-tool",
          language: "rust",
          symbols: [
            { id: "main", name: "main", qualifiedName: "crate::main", kind: "function", path: "src/main.rs", line: 1 },
            { id: "start", name: "start_server", qualifiedName: "crate::start_server", kind: "function", path: "src/lib.rs", line: 1, exported: true, confidence: "authoritative" }
          ],
          relationships: [
            { kind: "CALLS", fromSymbol: "main", fromPath: "src/main.rs", toSymbol: "start", toPath: "src/lib.rs", line: 1, confidence: "authoritative", reason: "fixture call graph" }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { symbolReports: [reportPath], index: true });
    expect(result.reports.some((report) => report.kind === "symbol-report")).toBe(true);
    const rustFile = result.index?.files.find((file) => file.path === "src/lib.rs");
    expect(rustFile?.language).toBe("rust");
    expect(rustFile?.source).toBe("git");
    const symbol = result.index?.symbols.find((candidate) => candidate.qualifiedName === "crate::start_server");
    expect(symbol?.confidence).toBe("derived");

    const context = await symbolContextQuery(repo, symbol!.id, { autoRefresh: false }, { depth: 2 });
    const contextData = context.data as { edgeEvidence?: Array<{ source: string; confidence: string; degraded: boolean }>; callers?: unknown[] };
    expect(contextData.callers?.length).toBeGreaterThan(0);
    expect(contextData.edgeEvidence?.some((edge) => edge.source === "static-analysis" && edge.confidence === "derived")).toBe(true);

    const impact = await impactQuery(repo, { symbol: symbol!.id }, { autoRefresh: false });
    const impactData = impact.data as {
      readFirstFiles?: string[];
      edgeEvidence?: Array<{ id: string; source: string }>;
      affectedFiles?: Array<{ file: { path: string }; evidenceIds?: string[] }>;
    };
    expect(impactData.readFirstFiles).toContain("src/lib.rs");
    expect(impactData.readFirstFiles).toContain("src/main.rs");
    expect(impactData.edgeEvidence?.some((edge) => edge.source === "static-analysis")).toBe(true);
    const staticAnalysisEvidenceIds = new Set(impactData.edgeEvidence?.filter((edge) => edge.source === "static-analysis").map((edge) => edge.id));
    const mainImpactEntry = impactData.affectedFiles?.find((entry) => entry.file.path === "src/main.rs");
    expect(mainImpactEntry?.evidenceIds?.some((id) => staticAnalysisEvidenceIds.has(id))).toBe(true);
  });

it("keeps path-level report relationships from becoming direct symbol callers", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-path-edge-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\npub fn unused() {}\n", "utf8");
    await writeFile(path.join(repo, "src/main.rs"), "fn main() { crate::used(); }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const reportPath = path.join(repo, "reports", "symbols-source.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "rust",
        symbols: [
          { id: "used", name: "used", qualifiedName: "crate::used", kind: "function", path: "src/lib.rs", line: 1 },
          { id: "unused", name: "unused", qualifiedName: "crate::unused", kind: "function", path: "src/lib.rs", line: 2 }
        ],
        relationships: [{ kind: "CALLS", fromPath: "src/main.rs", toPath: "src/lib.rs", line: 1, confidence: "derived", reason: "path-only call graph" }]
      }),
      "utf8"
    );
    const result = await updateStaticAnalysisReports(repo, { symbolReports: [reportPath], index: true });
    const unused = result.index?.symbols.find((candidate) => candidate.qualifiedName === "crate::unused");
    const context = await symbolContextQuery(repo, unused!.id, { autoRefresh: false }, { depth: 1 });
    expect((context.data as { callers?: unknown[] }).callers).toEqual([]);
    const impact = await impactQuery(repo, { symbol: unused!.id }, { autoRefresh: false });
    expect((impact.data as { readFirstFiles?: string[] }).readFirstFiles).not.toContain("src/main.rs");
  });

it("resolves path-qualified symbol report ids before falling back to duplicate global ids", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-path-id-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8");
    await writeFile(path.join(repo, "src/b.ts"), "export function beta() { return 2 }\n", "utf8");
    await writeFile(path.join(repo, "src/target.ts"), "export function target() { return 3 }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const reportPath = path.join(repo, "reports", "symbols-source.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "typescript",
        symbols: [
          { id: "dup", name: "alpha", qualifiedName: "alpha", kind: "function", path: "src/a.ts", line: 1 },
          { id: "dup", name: "beta", qualifiedName: "beta", kind: "function", path: "src/b.ts", line: 1 },
          { id: "target", name: "target", qualifiedName: "target", kind: "function", path: "src/target.ts", line: 1 }
        ],
        relationships: [{ kind: "CALLS", fromSymbol: "dup", fromPath: "src/b.ts", toSymbol: "target", toPath: "src/target.ts", line: 1, confidence: "derived", reason: "path-qualified duplicate id" }]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { symbolReports: [reportPath], index: true });
    expect(result.index?.graphEdges.some((edge) => edge.edgeKind === "CALLS" && edge.fromPath === "src/b.ts" && edge.toPath === "src/target.ts" && edge.source === "static-analysis" && edge.reason === "path-qualified duplicate id")).toBe(true);
    expect(result.index?.graphEdges.some((edge) => edge.edgeKind === "CALLS" && edge.fromPath === "src/a.ts" && edge.toPath === "src/target.ts" && edge.source === "static-analysis" && edge.reason === "path-qualified duplicate id")).toBe(false);
  });
});
