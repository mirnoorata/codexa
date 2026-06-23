import { promises as fs } from "node:fs";
import path from "node:path";
import { buildIndexLocked } from "./indexer.js";
import { loadExternalRiskSignalReport, type ExternalRiskReportDiagnostic } from "./risk-ingest.js";
import { CODEXA_SCIP_SYMBOL_REPORT_GENERATOR, convertScipJsonReportToSymbolReport } from "./scip-import.js";
import { validateCodexaSymbolReportFile } from "./symbol-report-ingest.js";
import type { CodexaIndex } from "./types.js";
import { isSubpath, normalizePath, stableId } from "./util.js";
import { runCommand } from "./command.js";

const STATIC_ANALYSIS_DIR = ".codex/static-analysis";
const CODEQL_DB_DIR = ".codex/cache/codeql-db";
const MAX_GENERATED_SYMBOL_REPORT_BYTES = 2 * 1024 * 1024;
const CODEXA_CODEQL_SARIF_GENERATOR = "codexa-codeql-runner";

export interface StaticAnalysisOptions {
  semgrepReports?: string[];
  codeqlReports?: string[];
  sarifReports?: string[];
  genericReports?: string[];
  symbolReports?: string[];
  scipReports?: string[];
  runSemgrep?: boolean;
  semgrepConfigs?: string[];
  runCodeql?: boolean;
  codeqlLanguages?: string[];
  codeqlSuite?: string;
  runShellcheck?: boolean;
  timeoutMs?: number;
  index?: boolean;
}

export interface StaticAnalysisReport {
  kind: "semgrep" | "codeql" | "sarif" | "generic" | "shellcheck" | "symbol-report" | "scip";
  source: string;
  path: string;
  copied: boolean;
}

export interface StaticAnalysisRun {
  tool: "semgrep" | "codeql" | "shellcheck";
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
  for (const source of options.symbolReports ?? []) {
    reports.push(await importSymbolReport(repoRoot, source));
  }
  const scipReports = options.scipReports ?? [];
  if (scipReports.length > 0) {
    const importedScipReports = await importScipReports(repoRoot, scipReports);
    reports.push(...importedScipReports);
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

  if (options.runShellcheck) {
    const run = await runShellcheck(repoRoot, timeoutMs);
    runs.push(run);
    reports.push(...run.reports.map((relativePath) => ({ kind: "shellcheck" as const, source: "shellcheck", path: relativePath, copied: false })));
  }

  const staticRiskReport = await loadExternalRiskSignalReport(repoRoot, "static-analysis-preview", new Date().toISOString());
  const staticRiskCount = staticRiskReport.risks.length;
  const index = options.index === false ? undefined : await buildIndexLocked({ repoRoot, writeArtifacts: true });
  return {
    repoRoot,
    reports: dedupeReports(reports),
    runs,
    staticRiskCount,
    index,
    text: renderStaticAnalysisSummary(repoRoot, dedupeReports(reports), runs, staticRiskCount, staticRiskReport.diagnostics, index)
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
  await copyFileAtomic(source, destination);
  return {
    kind,
    source,
    path: normalizePath(path.relative(repoRoot, destination)),
    copied: true
  };
}

async function importSymbolReport(repoRoot: string, sourceInput: string): Promise<StaticAnalysisReport> {
  await validateCodexaSymbolReportFile(repoRoot, sourceInput);
  return importReport(repoRoot, "symbol-report", sourceInput);
}

async function importScipReports(repoRoot: string, sourceInputs: string[]): Promise<StaticAnalysisReport[]> {
  const staged: Array<{ source: string; destination: string; temp: string; ready: boolean }> = [];
  let staleBackups: Array<{ destination: string; backup: string }> = [];
  try {
    for (const sourceInput of sourceInputs) {
      const source = path.resolve(sourceInput);
      const report = await convertScipJsonReportToSymbolReport(repoRoot, sourceInput);
      const destination = scipReportDestination(repoRoot, sourceInput);
      const temp = temporaryPath(destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const stagedReport = { source, destination, temp, ready: false };
      staged.push(stagedReport);
      await writeValidatedSymbolReportTemp(repoRoot, temp, report);
      stagedReport.ready = true;
    }
    const readyReports = staged.filter((report) => report.ready);
    staleBackups = await stageStaleGeneratedScipReports(repoRoot, readyReports.map((report) => report.destination));
    await publishStagedFiles(readyReports);
    await discardStagedFileBackups(staleBackups);
    staleBackups = [];
  } catch (error) {
    await Promise.all(staged.map((entry) => fs.rm(entry.temp, { force: true }).catch(() => undefined)));
    await restoreStagedFileBackups(staleBackups);
    throw error;
  }
  return staged.filter((report) => report.ready).map((entry) => ({
    kind: "scip" as const,
    source: entry.source,
    path: normalizePath(path.relative(repoRoot, entry.destination)),
    copied: true
  }));
}

function scipReportDestination(repoRoot: string, sourceInput: string): string {
  const source = path.resolve(sourceInput);
  return path.join(repoRoot, STATIC_ANALYSIS_DIR, reportFileName("scip", source).replace(/\.[^.]+$/i, ".symbols.json"));
}

async function stageStaleGeneratedScipReports(repoRoot: string, currentDestinations: string[]): Promise<Array<{ destination: string; backup: string }>> {
  const targetDir = path.join(repoRoot, STATIC_ANALYSIS_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  const keep = new Set(currentDestinations.map((destination) => path.basename(destination)));
  const entries = await fs.readdir(targetDir).catch(() => []);
  const staleReportCandidates = entries.filter((entry) => /^scip-.*\.symbols\.json$/u.test(entry) && !keep.has(entry)).map((entry) => path.join(targetDir, entry));
  const backups: Array<{ destination: string; backup: string }> = [];
  try {
    for (const staleReport of staleReportCandidates) {
      const staleStat = await lstatIfExists(staleReport);
      if (staleStat && !staleStat.isFile()) {
        throw new Error(`Stale generated SCIP report is not a file: ${normalizePath(staleReport)}`);
      }
    }
    const staleReports: string[] = [];
    for (const staleReport of staleReportCandidates) {
      if (await isCodexaGeneratedScipSymbolReport(staleReport)) {
        staleReports.push(staleReport);
      }
    }
    for (const staleReport of staleReports) {
      const staleStat = await lstatIfExists(staleReport);
      if (!staleStat) {
        continue;
      }
      const backup = temporaryPath(staleReport);
      await fs.rename(staleReport, backup);
      backups.push({ destination: staleReport, backup });
    }
    return backups;
  } catch (error) {
    await restoreStagedFileBackups(backups);
    throw error;
  }
}

async function isCodexaGeneratedScipSymbolReport(reportPath: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.symbols)) {
    return false;
  }
  if (record.generatedBy === CODEXA_SCIP_SYMBOL_REPORT_GENERATOR) {
    return true;
  }
  return false;
}

async function writeValidatedSymbolReportAtomic(repoRoot: string, destination: string, value: unknown): Promise<void> {
  const temp = temporaryPath(destination);
  try {
    await writeValidatedSymbolReportTemp(repoRoot, temp, value);
    await fs.rename(temp, destination);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeValidatedSymbolReportTemp(repoRoot: string, temp: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_GENERATED_SYMBOL_REPORT_BYTES) {
    throw new Error(`Generated symbol report exceeds ${MAX_GENERATED_SYMBOL_REPORT_BYTES} bytes: ${normalizePath(path.basename(temp))}`);
  }
  await fs.writeFile(temp, content, "utf8");
  await validateCodexaSymbolReportFile(repoRoot, temp);
}

async function copyFileAtomic(source: string, destination: string): Promise<void> {
  const temp = temporaryPath(destination);
  try {
    await fs.copyFile(source, temp);
    await fs.rename(temp, destination);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeFileAtomic(destination: string, content: string): Promise<void> {
  const temp = temporaryPath(destination);
  try {
    await fs.writeFile(temp, content, "utf8");
    await fs.rename(temp, destination);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function publishStagedFiles(entries: Array<{ temp: string; destination: string }>): Promise<void> {
  const destinations = new Set<string>();
  const backups: Array<{ destination: string; backup: string }> = [];
  const published: Array<{ destination: string }> = [];
  try {
    for (const entry of entries) {
      if (destinations.has(entry.destination)) {
        throw new Error(`Duplicate static analysis report destination: ${normalizePath(entry.destination)}`);
      }
      destinations.add(entry.destination);
      const tempStat = await fs.lstat(entry.temp);
      if (!tempStat.isFile()) {
        throw new Error(`Static analysis staged report is not a file: ${normalizePath(entry.temp)}`);
      }
      const destinationStat = await lstatIfExists(entry.destination);
      if (destinationStat && !destinationStat.isFile()) {
        throw new Error(`Static analysis report destination is not a file: ${normalizePath(entry.destination)}`);
      }
    }
    for (const entry of entries) {
      const destinationStat = await lstatIfExists(entry.destination);
      if (!destinationStat) {
        continue;
      }
      const backup = temporaryPath(entry.destination);
      await fs.rename(entry.destination, backup);
      backups.push({ destination: entry.destination, backup });
    }
    for (const entry of entries) {
      await fs.rename(entry.temp, entry.destination);
      published.push({ destination: entry.destination });
    }
    await Promise.all(backups.map((backup) => fs.rm(backup.backup, { force: true }).catch(() => undefined)));
  } catch (error) {
    await Promise.all(published.map((entry) => fs.rm(entry.destination, { force: true }).catch(() => undefined)));
    await restoreStagedFileBackups(backups);
    throw error;
  }
}

async function discardStagedFileBackups(backups: Array<{ backup: string }>): Promise<void> {
  await Promise.all(backups.map((backup) => fs.rm(backup.backup, { force: true }).catch(() => undefined)));
}

async function restoreStagedFileBackups(backups: Array<{ destination: string; backup: string }>): Promise<void> {
  for (const backup of backups.reverse()) {
    await fs.rename(backup.backup, backup.destination).catch(() => undefined);
  }
}

async function lstatIfExists(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function temporaryPath(destination: string): string {
  return `${destination}.${process.pid}.${stableId("tmp", destination, Date.now(), process.hrtime.bigint().toString())}.tmp`;
}

async function runSemgrep(repoRoot: string, configs: string[], timeoutMs: number): Promise<StaticAnalysisRun> {
  const output = path.join(repoRoot, STATIC_ANALYSIS_DIR, "semgrep.json");
  const tempOutput = temporaryPath(output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = [
    "scan",
    ...configs.flatMap((config) => ["--config", config]),
    "--json",
    "--json-output",
    tempOutput,
    "--metrics=off",
    repoRoot
  ];
  try {
    await runExternal("semgrep", args, { cwd: repoRoot, timeoutMs });
    await validateSemgrepReportFile(tempOutput);
    await publishStagedFiles([{ temp: tempOutput, destination: output }]);
  } catch (error) {
    await fs.rm(tempOutput, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    tool: "semgrep",
    command: commandForDisplay("semgrep", args.map((arg) => (arg === tempOutput ? output : arg))),
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

  const stagedReports: Array<{ output: string; tempOutput: string; ready: boolean }> = [];
  let staleBackups: Array<{ destination: string; backup: string }> = [];
  try {
    for (const language of selected) {
      const dbPath = await findCodeqlDatabase(dbRoot, language);
      if (!dbPath) {
        continue;
      }
      const suiteLanguage = codeqlSuiteLanguage(language);
      const output = path.join(repoRoot, STATIC_ANALYSIS_DIR, `codeql-${suiteLanguage}.sarif`);
      const tempOutput = temporaryPath(output);
      await fs.mkdir(path.dirname(output), { recursive: true });
      const analyzeArgs = [
        "database",
        "analyze",
        dbPath,
        `codeql/${suiteLanguage}-queries:codeql-suites/${suiteLanguage}-${suite}.qls`,
        "--format=sarif-latest",
        `--output=${tempOutput}`,
        `--sarif-category=${language}`,
        "--download"
      ];
      const stagedReport = { output, tempOutput, ready: false };
      stagedReports.push(stagedReport);
      await runExternal("codeql", analyzeArgs, { cwd: repoRoot, timeoutMs });
      await validateSarifReportFile(tempOutput);
      await markCodeqlSarifReport(tempOutput);
      stagedReport.ready = true;
    }
    const readyReports = stagedReports.filter((report) => report.ready);
    if (readyReports.length === 0) {
      throw new Error(`CodeQL database create completed, but no matching databases were found under ${normalizePath(path.relative(repoRoot, dbRoot))}.`);
    }
    staleBackups = await stageStaleGeneratedCodeqlReports(repoRoot, readyReports.map((report) => report.output));
    await publishStagedFiles(readyReports.map((report) => ({ temp: report.tempOutput, destination: report.output })));
    await discardStagedFileBackups(staleBackups);
    staleBackups = [];
  } catch (error) {
    await Promise.all(stagedReports.map((report) => fs.rm(report.tempOutput, { force: true }).catch(() => undefined)));
    await restoreStagedFileBackups(staleBackups);
    throw error;
  }
  const reports = stagedReports.filter((report) => report.ready).map((report) => normalizePath(path.relative(repoRoot, report.output)));
  return {
    tool: "codeql",
    command: `${commandForDisplay("codeql", createArgs)} && codeql database analyze ...`,
    reports
  };
}

async function stageStaleGeneratedCodeqlReports(repoRoot: string, currentDestinations: string[]): Promise<Array<{ destination: string; backup: string }>> {
  const targetDir = path.join(repoRoot, STATIC_ANALYSIS_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  const keep = new Set(currentDestinations.map((destination) => path.basename(destination)));
  const entries = await fs.readdir(targetDir).catch(() => []);
  const staleReportCandidates = entries.filter((entry) => /^codeql-(?:javascript|python)\.sarif$/u.test(entry) && !keep.has(entry)).map((entry) => path.join(targetDir, entry));
  const backups: Array<{ destination: string; backup: string }> = [];
  try {
    for (const staleReport of staleReportCandidates) {
      const staleStat = await lstatIfExists(staleReport);
      if (staleStat && !staleStat.isFile()) {
        throw new Error(`Stale generated CodeQL report is not a file: ${normalizePath(staleReport)}`);
      }
    }
    const staleReports: string[] = [];
    for (const staleReport of staleReportCandidates) {
      if (await isCodexaGeneratedCodeqlReport(staleReport)) {
        staleReports.push(staleReport);
      }
    }
    for (const staleReport of staleReports) {
      const staleStat = await lstatIfExists(staleReport);
      if (!staleStat) {
        continue;
      }
      const backup = temporaryPath(staleReport);
      await fs.rename(staleReport, backup);
      backups.push({ destination: staleReport, backup });
    }
    return backups;
  } catch (error) {
    await restoreStagedFileBackups(backups);
    throw error;
  }
}

async function isCodexaGeneratedCodeqlReport(reportPath: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const properties = (parsed as { properties?: unknown }).properties;
  return Boolean(properties && typeof properties === "object" && !Array.isArray(properties) && (properties as Record<string, unknown>).generatedBy === CODEXA_CODEQL_SARIF_GENERATOR);
}

async function runShellcheck(repoRoot: string, timeoutMs: number): Promise<StaticAnalysisRun> {
  const output = path.join(repoRoot, STATIC_ANALYSIS_DIR, "shellcheck.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const files = await discoverShellFiles(repoRoot, timeoutMs);
  const args = ["--format=json", ...files];
  if (files.length === 0) {
    await writeShellcheckRiskReport(output, repoRoot, [], files);
    return {
      tool: "shellcheck",
      command: "shellcheck --format=json <no shell files>",
      reports: [normalizePath(path.relative(repoRoot, output))]
    };
  }

  const result = await runCommand("shellcheck", args, {
    cwd: repoRoot,
    env: externalScannerEnv(),
    timeoutMs,
    maxBufferBytes: 16 * 1024 * 1024,
    okExitCodes: [0, 1],
    killProcessGroup: true
  });
  if (result.ok) {
    const parsed = parseShellcheckComments(result.stdout);
    await writeShellcheckRiskReport(output, repoRoot, parsed, files);
    return {
      tool: "shellcheck",
      command: commandForDisplay("shellcheck", args),
      reports: [normalizePath(path.relative(repoRoot, output))]
    };
  }

  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.exitCode === null && code === "ENOENT") {
    throw new Error("shellcheck is not installed or not on PATH. Install it separately, then rerun this Codexa command.");
  }
  if (result.timedOut) {
    throw new Error(`shellcheck timed out after ${timeoutMs}ms.`);
  }
  if (result.truncated) {
    throw new Error("shellcheck exceeded Codexa's external scanner output buffer.");
  }
  const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`shellcheck failed${details ? `: ${details.slice(0, 2000)}` : ""}`);
}

async function runExternal(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<void> {
  const result = await runCommand(command, args, {
    cwd: options.cwd,
    env: externalScannerEnv(),
    timeoutMs: options.timeoutMs,
    maxBufferBytes: 16 * 1024 * 1024,
    okExitCodes: [0],
    killProcessGroup: true
  });
  if (result.ok) {
    return;
  }
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.exitCode === null && code === "ENOENT") {
    throw new Error(`${command} is not installed or not on PATH. Install it separately, then rerun this Codexa command.`);
  }
  if (result.timedOut) {
    throw new Error(`${command} timed out after ${options.timeoutMs}ms.`);
  }
  if (result.truncated) {
    throw new Error(`${command} exceeded Codexa's external scanner output buffer.`);
  }
  const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`${command} failed${details ? `: ${details.slice(0, 2000)}` : ""}`);
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

async function discoverShellFiles(repoRoot: string, timeoutMs: number): Promise<string[]> {
  const tracked = await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    env: externalScannerEnv(),
    timeoutMs: Math.min(timeoutMs, 30_000),
    maxBufferBytes: 8 * 1024 * 1024,
    okExitCodes: [0]
  });
  const candidates = tracked.ok ? tracked.stdout.split("\0").filter(Boolean) : await walkShellFileCandidates(repoRoot);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const relativePath = normalizePath(candidate);
    if (seen.has(relativePath) || shouldSkipShellCandidate(relativePath)) {
      continue;
    }
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    if (isShellPath(relativePath) || (await hasShellShebang(absolutePath))) {
      seen.add(relativePath);
      result.push(relativePath);
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function walkShellFileCandidates(repoRoot: string): Promise<string[]> {
  const result: string[] = [];
  const ignoredDirs = new Set([".git", ".codex", "node_modules", "dist", "build", "coverage", "__pycache__", ".venv", "venv"]);
  async function walk(relativeDir: string, depth: number): Promise<void> {
    if (depth > 8 || result.length >= 5000) {
      return;
    }
    const absoluteDir = path.join(repoRoot, relativeDir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await fs.readdir(absoluteDir, { withFileTypes: true })).map((entry) => ({
        name: entry.name.toString(),
        isDirectory: () => entry.isDirectory(),
        isFile: () => entry.isFile()
      }));
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          await walk(relativePath, depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  }
  await walk("", 0);
  return result;
}

function shouldSkipShellCandidate(relativePath: string): boolean {
  return (
    relativePath.startsWith(".codex/") ||
    relativePath.startsWith(".git/") ||
    relativePath.includes("/node_modules/") ||
    relativePath.includes("/dist/") ||
    relativePath.includes("/build/")
  );
}

function isShellPath(relativePath: string): boolean {
  return /\.(bash|bats|ksh|sh|zsh)$/i.test(relativePath);
}

async function hasShellShebang(absolutePath: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    return /^#!.*\b(?:ba|z|k)?sh\b/.test(firstLine) || /^#!.*\b(?:env\s+)?sh\b/.test(firstLine);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface ShellcheckComment {
  file?: unknown;
  line?: unknown;
  level?: unknown;
  code?: unknown;
  message?: unknown;
}

function parseShellcheckComments(stdout: string): ShellcheckComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter(isShellcheckComment);
  }
  if (parsed && typeof parsed === "object") {
    const comments = (parsed as { comments?: unknown }).comments;
    if (Array.isArray(comments)) {
      return comments.filter(isShellcheckComment);
    }
  }
  return [];
}

function isShellcheckComment(value: unknown): value is ShellcheckComment {
  return Boolean(value && typeof value === "object");
}

async function writeShellcheckRiskReport(output: string, repoRoot: string, comments: ShellcheckComment[], files: string[]): Promise<void> {
  const risks = comments.flatMap((comment) => {
    const filePath = stringValue(comment.file);
    const normalizedPath = filePath ? normalizeShellcheckPath(filePath, repoRoot) : undefined;
    const code = numberValue(comment.code);
    const message = stringValue(comment.message) ?? "ShellCheck finding";
    if (!normalizedPath || !code) {
      return [];
    }
    const severity = shellcheckSeverity(stringValue(comment.level));
    return [
      {
        path: normalizedPath,
        line: numberValue(comment.line),
        signal: `shellcheck.SC${code}`,
        severity,
        confidence: "authoritative",
        score: shellcheckScore(severity),
        reason: message
      }
    ];
  });
  await writeFileAtomic(
    output,
    `${JSON.stringify(
      {
        tool: "shellcheck",
        generatedAt: new Date().toISOString(),
        files,
        risks
      },
      null,
      2
    )}\n`
  );
}

function normalizeShellcheckPath(filePath: string, repoRoot: string): string | undefined {
  const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(repoRoot, filePath);
  if (!isSubpath(absolutePath, repoRoot)) {
    return undefined;
  }
  const normalized = normalizePath(path.relative(repoRoot, absolutePath));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

async function validateSemgrepReportFile(filePath: string): Promise<void> {
  const parsed = await parseJsonReportFile(filePath, "Semgrep JSON report");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Semgrep produced a malformed JSON report.");
  }
}

async function validateSarifReportFile(filePath: string): Promise<void> {
  const parsed = await parseJsonReportFile(filePath, "SARIF report");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { runs?: unknown }).runs)) {
    throw new Error("CodeQL produced a malformed SARIF report.");
  }
}

async function markCodeqlSarifReport(filePath: string): Promise<void> {
  const parsed = await parseJsonReportFile(filePath, "SARIF report");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CodeQL produced a malformed SARIF report.");
  }
  const record = parsed as Record<string, unknown>;
  const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties as Record<string, unknown> : {};
  record.properties = { ...properties, generatedBy: CODEXA_CODEQL_SARIF_GENERATOR };
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function parseJsonReportFile(filePath: string, label: string): Promise<unknown> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} is not a regular file`);
    }
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shellcheckSeverity(level: string | undefined): string {
  const normalized = level?.toLowerCase();
  if (normalized === "error") {
    return "ERROR";
  }
  if (normalized === "warning") {
    return "WARNING";
  }
  return "INFO";
}

function shellcheckScore(severity: string): number {
  if (severity === "ERROR") {
    return 3;
  }
  if (severity === "WARNING") {
    return 2;
  }
  return 1;
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
  diagnostics: ExternalRiskReportDiagnostic[],
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
  if (diagnostics.length > 0) {
    lines.push("", "Report diagnostics:");
    for (const diagnostic of diagnostics.slice(0, 12)) {
      const size = diagnostic.sizeBytes === undefined ? "" : ` (${diagnostic.sizeBytes} bytes`;
      const cap = diagnostic.limitBytes === undefined ? "" : `; cap ${diagnostic.limitBytes} bytes`;
      lines.push(`- ${diagnostic.path}: ${diagnostic.reason}${size ? `${size}${cap})` : ""}`);
    }
  }
  if (runs.length > 0) {
    lines.push("", "External scanner runs:");
    for (const run of runs) {
      lines.push(`- ${run.tool}: ${run.command}`);
    }
  }
  lines.push("", "License boundary: Codexa ingests reports from user-installed tools; it does not vendor Semgrep, CodeQL, ShellCheck, rules, query packs, or binaries.");
  return lines.join("\n");
}
