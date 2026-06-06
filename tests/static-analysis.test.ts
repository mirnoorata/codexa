import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
