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

  it("imports SCIP JSON reports into derived symbol context and impact", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn start_server() {}\n", "utf8");
    await writeFile(path.join(repo, "src/main.rs"), "fn main() { crate::start_server(); }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const startSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ start_server().";
    const mainSymbol = "scip-rust cargo fixture 0.1.0 src/main.rs/ main().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        metadata: { projectRoot: "/tmp/not-this-repo", toolInfo: { name: "fixture-scip", version: "1.0" } },
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol: startSymbol, symbolRoles: 1, singleLineRange: { line: 0, startCharacter: 7, endCharacter: 19 }, singleLineEnclosingRange: { line: 0, startCharacter: 0, endCharacter: 24 } }],
            symbols: [{ symbol: startSymbol, displayName: "start_server", kind: "Function" }]
          },
          {
            relativePath: "src/main.rs",
            language: "rust",
            occurrences: [
              { symbol: mainSymbol, symbolRoles: 1, singleLineRange: { line: 0, startCharacter: 3, endCharacter: 7 }, singleLineEnclosingRange: { line: 0, startCharacter: 0, endCharacter: 36 } },
              { symbol: startSymbol, symbolRoles: 0, range: [0, 18, 30] }
            ],
            symbols: [{ symbol: mainSymbol, displayName: "main", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.reports.some((report) => report.kind === "scip" && report.path.endsWith(".symbols.json"))).toBe(true);
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      tool: string;
      symbols: Array<{ qualifiedName: string; line?: number; confidence?: string }>;
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string; confidence?: string }>;
    };
    expect(converted.tool).toBe("scip:fixture-scip:1.0");
    expect(converted.symbols.find((symbol) => symbol.qualifiedName === startSymbol)?.line).toBe(1);
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: mainSymbol, toSymbol: startSymbol, confidence: "derived" }));

    const symbol = result.index?.symbols.find((candidate) => candidate.qualifiedName === startSymbol);
    expect(symbol?.source).toBe("static-analysis");
    expect(symbol?.confidence).toBe("derived");

    const context = await symbolContextQuery(repo, symbol!.id, { autoRefresh: false }, { depth: 1 });
    const contextData = context.data as { callers?: unknown[]; edgeEvidence?: Array<{ edgeKind: string; source: string; confidence: string }> };
    expect(contextData.callers?.length).toBeGreaterThan(0);
    expect(contextData.edgeEvidence?.some((edge) => edge.edgeKind === "REFERENCES" && edge.source === "static-analysis" && edge.confidence === "derived")).toBe(true);

    const impact = await impactQuery(repo, { symbol: symbol!.id }, { autoRefresh: false });
    const impactData = impact.data as { readFirstFiles?: string[]; edgeEvidence?: Array<{ edgeKind: string; source: string }> };
    expect(impactData.readFirstFiles).toContain("src/lib.rs");
    expect(impactData.readFirstFiles).toContain("src/main.rs");
    expect(impactData.edgeEvidence?.some((edge) => edge.edgeKind === "REFERENCES" && edge.source === "static-analysis")).toBe(true);
  });

  it("maps SCIP symbol relationships without inventing path-only symbol callers", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-relationships-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/api.rs"), "trait Service {}\n", "utf8");
    await writeFile(path.join(repo, "src/impl.rs"), "struct Worker {}\nimpl Service for Worker {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const serviceSymbol = "scip-rust cargo fixture 0.1.0 src/api.rs/ Service#";
    const workerSymbol = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Worker#";
    const orphanSymbol = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Orphan#";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        metadata: { toolInfo: { name: "fixture-scip" } },
        documents: [
          {
            relativePath: "src/api.rs",
            language: "rust",
            occurrences: [{ symbol: serviceSymbol, symbolRoles: 1, range: [0, 6, 13], enclosingRange: [0, 0, 0, 16] }],
            symbols: [{ symbol: serviceSymbol, displayName: "Service", kind: "Trait" }]
          },
          {
            relativePath: "src/impl.rs",
            language: "rust",
            occurrences: [
              { symbol: workerSymbol, symbolRoles: 1, range: [0, 7, 13], enclosingRange: [0, 0, 0, 16] },
              { symbol: orphanSymbol, symbolRoles: 1, range: [1, 0, 6] },
              { symbol: serviceSymbol, symbolRoles: 0, range: [1, 5, 12] }
            ],
            symbols: [
              { symbol: workerSymbol, displayName: "Worker", kind: "Struct", relationships: [{ symbol: serviceSymbol, isImplementation: true }] },
              { symbol: orphanSymbol, displayName: "Orphan", kind: "Struct" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.index?.graphEdges.some((edge) => edge.edgeKind === "IMPLEMENTS" && edge.source === "static-analysis" && edge.confidence === "derived")).toBe(true);
    const service = result.index?.symbols.find((candidate) => candidate.qualifiedName === serviceSymbol);
    const context = await symbolContextQuery(repo, service!.id, { autoRefresh: false }, { depth: 1 });
    expect((context.data as { implementations?: unknown[] }).implementations?.length).toBeGreaterThan(0);

    const orphan = result.index?.symbols.find((candidate) => candidate.qualifiedName === orphanSymbol);
    const orphanContext = await symbolContextQuery(repo, orphan!.id, { autoRefresh: false }, { depth: 1 });
    expect((orphanContext.data as { callers?: unknown[] }).callers).toEqual([]);
  });

  it("rejects non-numeric SCIP role values", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-role-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ used().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: "not-definition", range: [0, 7, 11] }],
            symbols: [{ symbol, displayName: "used", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true })).rejects.toThrow(/symbolRoles must be a non-negative integer bitset/);
  });

  it("treats SCIP forward definitions as definitions rather than references", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-forward-definition-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn declared();\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ declared().";
    const scipPath = path.join(repo, "forward-definition.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 64, range: [0, 3, 11], enclosingRange: [0, 0, 0, 14] }],
            symbols: [{ symbol, displayName: "declared", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; line?: number }>;
      relationships?: Array<{ kind: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.symbols.find((candidate) => candidate.qualifiedName === symbol)?.line).toBe(1);
    expect(converted.relationships ?? []).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromPath: "src/lib.rs", toSymbol: symbol }));
  });

  it("keeps SCIP relationships for the document-local side of duplicate definitions", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-duplicate-definitions-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "trait Shared {}\ntrait Target {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "trait Shared {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const shared = "scip-rust cargo fixture 0.1.0 Shared#";
    const target = "scip-rust cargo fixture 0.1.0 Target#";
    const scipPath = path.join(repo, "duplicate-definitions.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/a.rs",
            language: "rust",
            occurrences: [
              { symbol: shared, symbolRoles: 1, range: [0, 6, 12] },
              { symbol: target, symbolRoles: 1, range: [1, 6, 12] }
            ],
            symbols: [{ symbol: shared, displayName: "Shared", kind: "Trait", relationships: [{ symbol: target, isReference: true }] }, { symbol: target, displayName: "Target", kind: "Trait" }]
          },
          {
            relativePath: "src/b.rs",
            language: "rust",
            occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }],
            symbols: [{ symbol: shared, displayName: "Shared", kind: "Trait" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; path: string }>;
      relationships: Array<{ kind: string; fromSymbol?: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.symbols.filter((candidate) => candidate.qualifiedName === shared).map((candidate) => candidate.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: shared, fromPath: "src/a.rs", toSymbol: target }));
  });

  it("keeps occurrence-derived duplicate SCIP definitions when symbol metadata is omitted", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-duplicate-fallback-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "trait Shared {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "trait Shared {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const shared = "scip-rust cargo fixture 0.1.0 Shared#";
    const scipPath = path.join(repo, "duplicate-fallback.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          { relativePath: "src/a.rs", language: "rust", occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }], symbols: [] },
          { relativePath: "src/b.rs", language: "rust", occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }], symbols: [] }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; path: string }>;
    };
    expect(converted.symbols.filter((candidate) => candidate.qualifiedName === shared).map((candidate) => candidate.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
  });

  it("rejects malformed SCIP object range integers instead of defaulting them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-object-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn target() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "object-range.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: { startLine: 0, startCharacter: -5, endCharacter: 3 } }],
            symbols: [{ symbol, displayName: "target", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/malformed range/);
  });

  it("uses SCIP character ranges to assign same-line references to the nearest enclosing symbol", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-character-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn aaa(){target()} fn zzz(){target()} fn target(){}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const aaa = "scip-rust cargo fixture 0.1.0 src/lib.rs/ aaa().";
    const zzz = "scip-rust cargo fixture 0.1.0 src/lib.rs/ zzz().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "same-line.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: aaa, symbolRoles: 1, range: [0, 3, 6], enclosingRange: [0, 0, 0, 18] },
              { symbol: zzz, symbolRoles: 1, range: [0, 22, 25], enclosingRange: [0, 19, 0, 37] },
              { symbol: target, symbolRoles: 0, range: [0, 28, 34] },
              { symbol: target, symbolRoles: 1, range: [0, 42, 48] }
            ],
            symbols: [
              { symbol: aaa, displayName: "aaa", kind: "Function" },
              { symbol: zzz, displayName: "zzz", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: zzz, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: aaa, toSymbol: target }));
  });

  it("sorts enclosing SCIP ranges by tuple specificity instead of scaled width", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-long-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn outer() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const outer = "scip-rust cargo fixture 0.1.0 src/lib.rs/ outer().";
    const inner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ inner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "long-range.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: outer, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 1, 0] },
              { symbol: inner, symbolRoles: 1, range: [0, 0, 1], enclosingRange: [0, 0, 0, 2_000_000] },
              { symbol: target, symbolRoles: 0, range: [0, 100, 101] },
              { symbol: target, symbolRoles: 1, range: [0, 13, 19] }
            ],
            symbols: [
              { symbol: outer, displayName: "outer", kind: "Function" },
              { symbol: inner, displayName: "inner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: inner, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: outer, toSymbol: target }));
  });

  it("prefers the inner enclosing SCIP range when multiline ranges have equal line spans", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-equal-span-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn outer() {\n  target();\n}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const outer = "scip-rust cargo fixture 0.1.0 src/lib.rs/ outer().";
    const inner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ inner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "equal-span.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: outer, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 2, 10] },
              { symbol: inner, symbolRoles: 1, range: [0, 13, 18], enclosingRange: [0, 5, 2, 8] },
              { symbol: target, symbolRoles: 0, range: [1, 2, 8] },
              { symbol: target, symbolRoles: 1, range: [1, 2, 8] }
            ],
            symbols: [
              { symbol: outer, displayName: "outer", kind: "Function" },
              { symbol: inner, displayName: "inner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: inner, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: outer, toSymbol: target }));
  });

  it("keeps recursive SCIP references as symbol-to-symbol relationships", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-recursive-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn recur(){recur()}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const recur = "scip-rust cargo fixture 0.1.0 src/lib.rs/ recur().";
    const scipPath = path.join(repo, "recursive.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: recur, symbolRoles: 1, range: [0, 3, 8], enclosingRange: [0, 0, 0, 19] },
              { symbol: recur, symbolRoles: 0, range: [0, 11, 16] }
            ],
            symbols: [{ symbol: recur, displayName: "recur", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: recur, toSymbol: recur }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromPath: "src/lib.rs", toSymbol: recur, fromSymbol: undefined }));
  });

  it("does not map SCIP definition-navigation relationships to caller references", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-navigation-flags-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/api.rs"), "trait Service {}\n", "utf8");
    await writeFile(path.join(repo, "src/impl.rs"), "struct Worker {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const service = "scip-rust cargo fixture 0.1.0 src/api.rs/ Service#";
    const worker = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Worker#";
    const scipPath = path.join(repo, "navigation-flags.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/api.rs",
            language: "rust",
            occurrences: [{ symbol: service, symbolRoles: 1, range: [0, 6, 13] }],
            symbols: [{ symbol: service, displayName: "Service", kind: "Trait" }]
          },
          {
            relativePath: "src/impl.rs",
            language: "rust",
            occurrences: [{ symbol: worker, symbolRoles: 1, range: [0, 7, 13] }],
            symbols: [{ symbol: worker, displayName: "Worker", kind: "Struct", relationships: [{ symbol: service, isDefinition: true }, { symbol: service, isTypeDefinition: true }] }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: worker, toSymbol: service }));
  });

  it("rejects malformed, oversized, and unsafe SCIP JSON reports before import", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-invalid-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-outside-"));
    await writeFile(path.join(outside, "escape.rs"), "pub fn escape() {}\n", "utf8");
    await symlink(path.join(outside, "escape.rs"), path.join(repo, "src", "escape.rs"));

    const invalidJson = path.join(repo, "invalid.scip");
    await writeFile(invalidJson, "not-json", "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [invalidJson], index: false })).rejects.toThrow(/scip print --json/);

    const missingDocuments = path.join(repo, "missing-documents.scip.json");
    await writeFile(missingDocuments, JSON.stringify({ metadata: {} }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [missingDocuments], index: false })).rejects.toThrow(/documents array/);

    const unsafePath = path.join(repo, "unsafe.scip.json");
    await writeFile(unsafePath, JSON.stringify({ documents: [{ relativePath: "../escape.rs", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [unsafePath], index: false })).rejects.toThrow(/canonical relative path/);

    const whitespacePath = path.join(repo, "whitespace-path.scip.json");
    await writeFile(whitespacePath, JSON.stringify({ documents: [{ relativePath: " src/lib.rs ", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [whitespacePath], index: false })).rejects.toThrow(/canonical relative path/);

    const symlinkPath = path.join(repo, "symlink.scip.json");
    await writeFile(symlinkPath, JSON.stringify({ documents: [{ relativePath: "src/escape.rs", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [symlinkPath], index: false })).rejects.toThrow(/existing repository file|outside the repository/);

    const malformedRange = path.join(repo, "malformed-range.scip.json");
    await writeFile(
      malformedRange,
      JSON.stringify({ documents: [{ relativePath: "src/lib.rs", occurrences: [{ symbol: "scip-rust . lib().", symbolRoles: 1, range: [-1, 0, 1] }], symbols: [] }] }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [malformedRange], index: false })).rejects.toThrow(/malformed range/);

    const oversized = path.join(repo, "oversized.scip.json");
    await writeFile(oversized, " ".repeat(17 * 1024 * 1024), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [oversized], index: false })).rejects.toThrow(/exceeds/);

    const preserved = path.join(repo, "preserved.scip.json");
    await writeFile(
      preserved,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ preserved().", displayName: "preserved", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const preservedImport = await updateStaticAnalysisReports(repo, { scipReports: [preserved], index: false });
    const preservedReport = preservedImport.reports.find((report) => report.kind === "scip")!;
    const preservedContent = await readFile(path.join(repo, preservedReport.path), "utf8");

    await writeFile(
      preserved,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: Array.from({ length: 3_000 }, (_, index) => ({
              symbol: `scip-rust cargo fixture 0.1.0 src/lib.rs/ ${"x".repeat(900)}${index}().`,
              displayName: `preserved${index}`,
              kind: "Function"
            }))
          }
        ]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [preserved], index: false })).rejects.toThrow(/Generated symbol report exceeds/);
    expect(await readFile(path.join(repo, preservedReport.path), "utf8")).toBe(preservedContent);

    const hugeSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ ";
    const tooLargeConverted = path.join(repo, "too-large-converted.scip.json");
    await writeFile(
      tooLargeConverted,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: Array.from({ length: 3_000 }, (_, index) => ({
              symbol: `${hugeSymbol}${"x".repeat(900)}${index}().`,
              displayName: `used${index}`,
              kind: "Function"
            }))
          }
        ]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [tooLargeConverted], index: false })).rejects.toThrow(/Generated symbol report exceeds/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("too-large-converted") || entry.endsWith(".tmp"))).toEqual([]);
  });

  it("does not publish partial generated SCIP reports when a later source fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-batch-atomic-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn imported() {}\n", "utf8");

    const valid = path.join(repo, "valid-new.scip.json");
    await writeFile(
      valid,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ imported().", displayName: "imported", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const invalid = path.join(repo, "invalid-new.scip.json");
    await writeFile(invalid, JSON.stringify({ metadata: {} }), "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [valid, invalid], index: false })).rejects.toThrow(/documents array/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("valid-new") || entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rolls back generated SCIP reports when final publish fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-publish-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn first() {}\npub fn second() {}\n", "utf8");

    const first = path.join(repo, "first-publish.scip.json");
    const second = path.join(repo, "second-publish.scip.json");
    for (const [reportPath, name] of [
      [first, "first"],
      [second, "second"]
    ] as const) {
      await writeFile(
        reportPath,
        JSON.stringify({
          documents: [
            {
              relativePath: "src/lib.rs",
              language: "rust",
              occurrences: [],
              symbols: [{ symbol: `scip-rust cargo fixture 0.1.0 src/lib.rs/ ${name}().`, displayName: name, kind: "Function" }]
            }
          ]
        }),
        "utf8"
      );
    }

    const secondImport = await updateStaticAnalysisReports(repo, { scipReports: [second], index: false });
    const secondDestination = path.join(repo, secondImport.reports.find((report) => report.kind === "scip")!.path);
    await rm(secondDestination, { force: true });
    await mkdir(secondDestination, { recursive: true });

    await expect(updateStaticAnalysisReports(repo, { scipReports: [first, second], index: false })).rejects.toThrow(/destination is not a file/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("first-publish") || entry.endsWith(".tmp"))).toEqual([]);
  });

  it("restores stale generated SCIP reports when final publish fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-publish-restores-stale-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn fresh() {}\n", "utf8");

    const fresh = path.join(repo, "fresh-publish.scip.json");
    await writeFile(
      fresh,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ fresh().", displayName: "fresh", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const firstImport = await updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false });
    const freshDestination = path.join(repo, firstImport.reports.find((report) => report.kind === "scip")!.path);
    await rm(freshDestination, { force: true });
    await mkdir(freshDestination, { recursive: true });
    const staleReport = path.join(repo, ".codex/static-analysis/scip-old.symbols.json");
    await writeFile(staleReport, '{"schemaVersion":1,"tool":"old","language":"rust","symbols":[]}\n', "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false })).rejects.toThrow(/destination is not a file/);
    expect(await readFile(staleReport, "utf8")).toContain('"tool":"old"');
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("does not publish new SCIP reports when stale generated pruning fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-prune-fails-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    const staleFile = path.join(repo, ".codex/static-analysis/scip-stale-file.symbols.json");
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, '{"schemaVersion":1,"tool":"stale","language":"rust","symbols":[]}\n', "utf8");
    await mkdir(path.join(repo, ".codex/static-analysis/scip-stale.symbols.json"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn fresh() {}\n", "utf8");

    const fresh = path.join(repo, "fresh-prune.scip.json");
    await writeFile(
      fresh,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ fresh().", displayName: "fresh", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false })).rejects.toThrow();
    expect(await readFile(staleFile, "utf8")).toContain('"tool":"stale"');
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("fresh-prune") || entry.endsWith(".tmp"))).toEqual([]);
  });

  it("caps occurrence-derived SCIP relationships before generated report write", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-relationship-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn owner() {}\npub fn target() {}\n", "utf8");

    const owner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ owner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "relationship-cap.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: owner, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 2, 0] },
              { symbol: target, symbolRoles: 1, range: [1, 7, 13] },
              ...Array.from({ length: 50_001 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 7, 13] }))
            ],
            symbols: [
              { symbol: owner, displayName: "owner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/more than 50000 relationships/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

  it("caps SCIP enclosing range derivation cost before scanning a hostile cross product", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-range-check-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn target() {}\n", "utf8");

    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const owners = Array.from({ length: 1_001 }, (_, index) => `scip-rust cargo fixture 0.1.0 src/lib.rs/ owner${index}().`);
    const scipPath = path.join(repo, "range-check-cap.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: target, symbolRoles: 1, range: [0, 7, 13] },
              ...owners.map((symbol, index) => ({ symbol, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 0, 1 + index] })),
              ...Array.from({ length: 1_001 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 0, 1] }))
            ],
            symbols: [
              { symbol: target, displayName: "target", kind: "Function" },
              ...owners.map((symbol, index) => ({ symbol, displayName: `owner${index}`, kind: "Function" }))
            ]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/enclosing range checks/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

  it("caps SCIP enclosing range derivation cost across documents", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-global-range-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "pub fn target_a() {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "pub fn target_b() {}\n", "utf8");

    const document = (name: string) => {
      const target = `scip-rust cargo fixture 0.1.0 src/${name}.rs/ target_${name}().`;
      const owners = Array.from({ length: 501 }, (_, index) => `scip-rust cargo fixture 0.1.0 src/${name}.rs/ owner${index}().`);
      return {
        relativePath: `src/${name}.rs`,
        language: "rust",
        occurrences: [
          { symbol: target, symbolRoles: 1, range: [0, 7, 15] },
          ...owners.map((symbol, index) => ({ symbol, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 0, 1 + index] })),
          ...Array.from({ length: 1_000 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 0, 1] }))
        ],
        symbols: [{ symbol: target, displayName: `target_${name}`, kind: "Function" }, ...owners.map((symbol, index) => ({ symbol, displayName: `owner${index}`, kind: "Function" }))]
      };
    };
    const scipPath = path.join(repo, "global-range-cap.scip.json");
    await writeFile(scipPath, JSON.stringify({ documents: [document("a"), document("b")] }), "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/enclosing range checks/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

  it("prunes stale generated SCIP conversions when a new SCIP source is imported", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-prune-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn current() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const oldSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ old_symbol().";
    const newSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ new_symbol().";
    const oldScip = path.join(repo, "old.scip.json");
    const newScip = path.join(repo, "new.scip.json");
    const scipReport = (symbol: string) =>
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: symbol.includes("old") ? "old_symbol" : "new_symbol", kind: "Function" }]
          }
        ]
      });
    await writeFile(oldScip, scipReport(oldSymbol), "utf8");
    await writeFile(newScip, scipReport(newSymbol), "utf8");

    const first = await updateStaticAnalysisReports(repo, { scipReports: [oldScip], index: true });
    const firstGenerated = first.reports.find((report) => report.kind === "scip")!;
    await writeFile(path.join(repo, "bad.scip.json"), JSON.stringify({ metadata: {} }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [path.join(repo, "bad.scip.json")], index: true })).rejects.toThrow(/documents array/);
    await expect(readFile(path.join(repo, firstGenerated.path), "utf8")).resolves.toContain(oldSymbol);

    const updated = await updateStaticAnalysisReports(repo, { scipReports: [newScip], index: true });
    const generated = (await readdir(path.join(repo, ".codex/static-analysis"))).filter((entry) => /^scip-.*\.symbols\.json$/u.test(entry));

    expect(generated).toHaveLength(1);
    expect(generated[0]).toContain("new.scip");
    expect(updated.index?.symbols.some((symbol) => symbol.qualifiedName === newSymbol)).toBe(true);
    expect(updated.index?.symbols.some((symbol) => symbol.qualifiedName === oldSymbol)).toBe(false);
  });

  it("preserves user-managed scip-named symbol reports during SCIP pruning", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-preserve-thirdparty-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn current() {}\n", "utf8");
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const thirdPartyReport = path.join(repo, ".codex/static-analysis/scip-thirdparty.symbols.json");
    await writeFile(
      thirdPartyReport,
      JSON.stringify({
        schemaVersion: 1,
        tool: "scip-typescript",
        language: "rust",
        symbols: [{ id: "scip-thirdparty", name: "thirdparty", qualifiedName: "scip-thirdparty", kind: "function", path: "src/lib.rs", line: 1 }]
      }),
      "utf8"
    );

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ current().";
    const scipPath = path.join(repo, "current.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: "current", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    await expect(readFile(thirdPartyReport, "utf8")).resolves.toContain("scip-typescript");
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === "scip-thirdparty" && candidate.source === "static-analysis")).toBe(true);
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === symbol && candidate.source === "static-analysis")).toBe(true);
  });

  it("does not let ambient symbol reports crowd out generated SCIP symbols", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-crowd-out-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn indexed() {}\n", "utf8");
    for (let index = 0; index < 55; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(2, "0")}.symbols.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "ambient-symbol-tool",
          language: "rust",
          symbols: [{ id: `ambient-${index}`, name: `ambient${index}`, qualifiedName: `ambient${index}`, kind: "function", path: "src/lib.rs", line: 1 }]
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ indexed().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: "indexed", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === symbol && candidate.source === "static-analysis")).toBe(true);
  });

  it("does not let generated SCIP reports crowd out an explicitly imported symbol report", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-crowd-out-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn imported() {}\n", "utf8");
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `scip-ambient-${String(index).padStart(2, "0")}.symbols.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "ambient-scip",
          language: "rust",
          symbols: [{ id: `ambient-${index}`, name: `ambient${index}`, qualifiedName: `ambient${index}`, kind: "function", path: "src/lib.rs", line: 1 }]
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbolReport = path.join(repo, "external-symbols.json");
    await writeFile(
      symbolReport,
      JSON.stringify({
        schemaVersion: 1,
        tool: "explicit-symbol-tool",
        language: "rust",
        symbols: [{ id: "imported", name: "importedExternal", qualifiedName: "external::imported", kind: "function", path: "src/lib.rs", line: 2 }]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { symbolReports: [symbolReport], index: true });
    const importedReport = result.reports.find((report) => report.kind === "symbol-report")!;
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === "external::imported" && candidate.source === "static-analysis")).toBe(true);
    expect(result.index?.freshness.externalSymbolReportHashes?.[importedReport.path]).toBeTruthy();
  });

  it("rejects malformed symbol report relationships during strict import", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-invalid-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const reportPath = path.join(repo, "bad-symbols.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "rust",
        symbols: [{ id: "used", name: "used", qualifiedName: "crate::used", kind: "function", path: "src/lib.rs", line: 1 }],
        relationships: [{ kind: "USES_WRONG_KIND", fromPath: "src/lib.rs", toPath: "src/lib.rs" }]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { symbolReports: [reportPath], index: false })).rejects.toThrow(/relationships\[0\]\.kind is unsupported/);
  });
});
