import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildIndexLocked } from "./indexer.js";
import { loadExternalRiskSignals } from "./risk-ingest.js";
import type { CodexaIndex } from "./types.js";
import { isSubpath, normalizePath, stableId } from "./util.js";

const execFileAsync = promisify(execFile);
const STATIC_ANALYSIS_DIR = ".codex/static-analysis";
const CODEQL_DB_DIR = ".codex/cache/codeql-db";

export interface StaticAnalysisOptions {
  semgrepReports?: string[];
  codeqlReports?: string[];
  sarifReports?: string[];
  genericReports?: string[];
  runSemgrep?: boolean;
  semgrepConfigs?: string[];
  runCodeql?: boolean;
  codeqlLanguages?: string[];
  codeqlSuite?: string;
  timeoutMs?: number;
  index?: boolean;
}

export interface StaticAnalysisReport {
  kind: "semgrep" | "codeql" | "sarif" | "generic";
  source: string;
  path: string;
  copied: boolean;
}

export interface StaticAnalysisRun {
  tool: "semgrep" | "codeql";
  command: string;
  reports: string[];
}

export interface StaticAnalysisSummary {
  repoRoot: string;
  reports: StaticAnalysisReport[];
  runs: StaticAnalysisRun[];
  staticRiskCount: number;
  index?: CodexaIndex;
  text: string;
}

export async function updateStaticAnalysisReports(repoInput: string, options: StaticAnalysisOptions = {}): Promise<StaticAnalysisSummary> {
  const repoRoot = path.resolve(repoInput);
  const timeoutMs = options.timeoutMs ?? 600_000;
  const reports: StaticAnalysisReport[] = [];
  const runs: StaticAnalysisRun[] = [];

  for (const source of options.semgrepReports ?? []) {
    reports.push(await importReport(repoRoot, "semgrep", source));
  }
  for (const source of options.codeqlReports ?? []) {
    reports.push(await importReport(repoRoot, "codeql", source));
  }
  for (const source of options.sarifReports ?? []) {
    reports.push(await importReport(repoRoot, "sarif", source));
  }
  for (const source of options.genericReports ?? []) {
    reports.push(await importReport(repoRoot, "generic", source));
  }

  if (options.runSemgrep) {
    const run = await runSemgrep(repoRoot, options.semgrepConfigs ?? ["p/default"], timeoutMs);
    runs.push(run);
    reports.push(...run.reports.map((relativePath) => ({ kind: "semgrep" as const, source: "semgrep scan", path: relativePath, copied: false })));
  }

  if (options.runCodeql) {
    const run = await runCodeql(repoRoot, options.codeqlLanguages ?? ["javascript-typescript", "python"], options.codeqlSuite ?? "code-scanning", timeoutMs);
    runs.push(run);
    reports.push(...run.reports.map((relativePath) => ({ kind: "codeql" as const, source: "codeql database analyze", path: relativePath, copied: false })));
  }

  const staticRiskCount = (await loadExternalRiskSignals(repoRoot, "static-analysis-preview", new Date().toISOString())).length;
  const index = options.index === false ? undefined : await buildIndexLocked({ repoRoot, writeArtifacts: true });
  return {
    repoRoot,
    reports: dedupeReports(reports),
    runs,
    staticRiskCount,
    index,
    text: renderStaticAnalysisSummary(repoRoot, dedupeReports(reports), runs, staticRiskCount, index)
  };
}

async function importReport(repoRoot: string, kind: StaticAnalysisReport["kind"], sourceInput: string): Promise<StaticAnalysisReport> {
  const source = path.resolve(sourceInput);
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Static analysis report not found or not a file: ${sourceInput}`);
  }
  const targetDir = path.join(repoRoot, STATIC_ANALYSIS_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  if (isSubpath(source, targetDir)) {
    return {
      kind,
      source,
      path: normalizePath(path.relative(repoRoot, source)),
      copied: false
    };
  }
  const destination = path.join(targetDir, reportFileName(kind, source));
  await fs.copyFile(source, destination);
  return {
    kind,
    source,
    path: normalizePath(path.relative(repoRoot, destination)),
    copied: true
  };
}

async function runSemgrep(repoRoot: string, configs: string[], timeoutMs: number): Promise<StaticAnalysisRun> {
  const output = path.join(repoRoot, STATIC_ANALYSIS_DIR, "semgrep.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = [
    "scan",
    ...configs.flatMap((config) => ["--config", config]),
    "--json",
    "--json-output",
    output,
    "--metrics=off",
    repoRoot
  ];
  await runExternal("semgrep", args, { cwd: repoRoot, timeoutMs });
  return {
    tool: "semgrep",
    command: commandForDisplay("semgrep", args),
    reports: [normalizePath(path.relative(repoRoot, output))]
  };
}

async function runCodeql(repoRoot: string, languages: string[], suite: string, timeoutMs: number): Promise<StaticAnalysisRun> {
  const selected = normalizeCodeqlLanguages(languages);
  if (selected.length === 0) {
    throw new Error("At least one CodeQL language is required.");
  }
  const dbRoot = path.join(repoRoot, CODEQL_DB_DIR);
  await fs.rm(dbRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dbRoot), { recursive: true });
  const createArgs = ["database", "create", dbRoot, "--db-cluster", `--language=${selected.join(",")}`, "--source-root", repoRoot, "--no-run-unnecessary-builds"];
  await runExternal("codeql", createArgs, { cwd: repoRoot, timeoutMs });

  const reports: string[] = [];
  for (const language of selected) {
    const dbPath = await findCodeqlDatabase(dbRoot, language);
    if (!dbPath) {
      continue;
    }
    const suiteLanguage = codeqlSuiteLanguage(language);
    const output = path.join(repoRoot, STATIC_ANALYSIS_DIR, `codeql-${suiteLanguage}.sarif`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const analyzeArgs = [
      "database",
      "analyze",
      dbPath,
      `codeql/${suiteLanguage}-queries:codeql-suites/${suiteLanguage}-${suite}.qls`,
      "--format=sarif-latest",
      `--output=${output}`,
      `--sarif-category=${language}`,
      "--download"
    ];
    await runExternal("codeql", analyzeArgs, { cwd: repoRoot, timeoutMs });
    reports.push(normalizePath(path.relative(repoRoot, output)));
  }
  if (reports.length === 0) {
    throw new Error(`CodeQL database create completed, but no matching databases were found under ${normalizePath(path.relative(repoRoot, dbRoot))}.`);
  }
  return {
    tool: "codeql",
    command: `${commandForDisplay("codeql", createArgs)} && codeql database analyze ...`,
    reports
  };
}

async function runExternal(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd,
      env: externalScannerEnv(),
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    const record = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (record.code === "ENOENT") {
      throw new Error(`${command} is not installed or not on PATH. Install it separately, then rerun this Codexa command.`);
    }
    const details = [record.stderr, record.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${details ? `: ${details.slice(0, 2000)}` : ""}`);
  }
}

function externalScannerEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "ComSpec"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.CODEXA_EXTERNAL_SCANNER = "1";
  return env;
}

function reportFileName(kind: StaticAnalysisReport["kind"], source: string): string {
  const ext = path.extname(source).toLowerCase() || ".json";
  const base = path.basename(source, path.extname(source)).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "report";
  const hash = stableId(kind, source);
  return `${kind}-${base}-${hash}${ext}`;
}

function dedupeReports(reports: StaticAnalysisReport[]): StaticAnalysisReport[] {
  const seen = new Set<string>();
  const result: StaticAnalysisReport[] = [];
  for (const report of reports) {
    const key = `${report.kind}\0${report.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(report);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

function normalizeCodeqlLanguages(languages: string[]): string[] {
  const aliases: Record<string, string> = {
    javascript: "javascript-typescript",
    typescript: "javascript-typescript",
    js: "javascript-typescript",
    ts: "javascript-typescript",
    py: "python"
  };
  return [...new Set(languages.map((language) => aliases[language] ?? language).filter((language) => ["javascript-typescript", "python"].includes(language)))].sort();
}

async function findCodeqlDatabase(dbRoot: string, language: string): Promise<string | undefined> {
  const candidates = uniqueCodeqlDbCandidates(language).map((candidate) => path.join(dbRoot, candidate));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) {
      return candidate;
    }
  }
  return undefined;
}

function uniqueCodeqlDbCandidates(language: string): string[] {
  if (language === "javascript-typescript") {
    return ["javascript-typescript", "javascript", "typescript"];
  }
  return [language];
}

function codeqlSuiteLanguage(language: string): string {
  return language === "javascript-typescript" ? "javascript" : language;
}

function commandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(shellWord).join(" ");
}

function shellWord(value: string): string {
  if (/^[a-zA-Z0-9_./:=,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderStaticAnalysisSummary(
  repoRoot: string,
  reports: StaticAnalysisReport[],
  runs: StaticAnalysisRun[],
  staticRiskCount: number,
  index: CodexaIndex | undefined
): string {
  const lines = [
    "Codexa static-analysis update",
    `Repo: ${repoRoot}`,
    `Reports available: ${reports.length}`,
    `Static-analysis risk facts: ${staticRiskCount}`,
    index ? `Reindexed: ${index.files.length} files, ${index.symbols.length} symbols, ${index.usageSites.length} usage sites` : "Reindexed: skipped"
  ];
  if (reports.length > 0) {
    lines.push("", "Reports:");
    for (const report of reports) {
      lines.push(`- ${report.path}: ${report.kind}${report.copied ? "; copied" : "; existing/generated"}`);
    }
  }
  if (runs.length > 0) {
    lines.push("", "External scanner runs:");
    for (const run of runs) {
      lines.push(`- ${run.tool}: ${run.command}`);
    }
  }
  lines.push("", "License boundary: Codexa ingests reports from user-installed tools; it does not vendor Semgrep or CodeQL engines, rules, query packs, or binaries.");
  return lines.join("\n");
}
