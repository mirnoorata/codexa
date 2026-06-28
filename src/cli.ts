#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexLocked } from "./indexer.js";
import { defaultAutonomyMode, effectiveAutonomyMode, parseAutonomyMode, setAutonomyMode } from "./autonomy.js";
import { checkGithubSync } from "./github-sync.js";
import { publishProjectGithubRelease } from "./github-release.js";
import { runDoctor } from "./doctor.js";
import { initializeProject, sessionStartSummary } from "./init.js";
import { runLiveIndexer } from "./live-index.js";
import { serveMcp, serveMcpHttp, type McpTransportKind } from "./mcp.js";
import { buildSemanticIndex, type SemanticProviderKind } from "./semantic-retrieval.js";
import { updateStaticAnalysisReports } from "./static-analysis.js";
import { initializePolicyPack } from "./policy-pack.js";
import { proveQuery } from "./prove.js";
import { recordAdvisoryHookEvent, runPostEditHook, runPreEditHook } from "./cli/hooks.js";
import type { ChangeType } from "./types.js";
import { runEval } from "./eval.js";
import { registerQueryCommands } from "./cli/query-commands.js";
import {
  invokedCliName,
  logLiveIndexEvent,
  parseAutonomyOption,
  parseChangeType,
  parseCommandReportOptions,
  parseIntOption,
  parseMcpTransport,
  parseSemanticProvider,
  parseSessionMemoryMode,
  parseToolProfile,
  parseWaiverOptions,
  queryOptionsFromCli,
  resolveQueryRepoRoot,
  type CliQueryOptions
} from "./cli/options.js";
import { CODEXA_VERSION } from "./version.js";

const program = new Command();
const cliModulePath = fileURLToPath(import.meta.url);
const defaultCliPath = cliModulePath.endsWith(`${path.sep}src${path.sep}cli.ts`)
  ? path.resolve(path.dirname(cliModulePath), "../dist/cli.js")
  : cliModulePath;

program
  .name(invokedCliName())
  .description("Codex-native codebase intelligence context compiler and MCP context server.")
  .version(CODEXA_VERSION);

program
  .command("init")
  .argument("[repo]", "repository root; defaults to the current git root")
  .option("--server-name <name>", "MCP server name to write in .codex/config.toml")
  .option("--cli-path <path>", "path Codex should use to start Codexa", defaultCliPath)
  .option("--auto-refresh", "allow Codexa MCP context tools to refresh stale generated artifacts", true)
  .option("--no-auto-refresh", "disable Codexa MCP auto-refresh in generated config")
  .option("--hooks", "write the repo-local Codex SessionStart hook", true)
  .option("--no-hooks", "do not write hooks.json")
  .option("--index", "index the repository immediately", true)
  .option("--no-index", "only write Codex config and hooks")
  .option("--tools <profile>", "MCP tool exposure profile: core (primary loop, cheaper per turn) or full; defaults to the repo's existing profile, else core", parseToolProfile)
  .option("--agents-md", "write a managed Codexa workflow block into the repo's AGENTS.md (Codex)", false)
  .option("--claude-md", "write a managed Codexa workflow block into the repo's CLAUDE.md (Claude Code)", false)
  .option("--claude", "write the codexa MCP server entry into the repo's .mcp.json for Claude Code", false)
  .option("--policy-pack", "also create the default local proof policy pack without overwriting existing policy files", false)
  .description("Initialize Codexa for a project so future Codex sessions discover it automatically.")
  .action(
    async (
      repo: string | undefined,
      opts: {
        serverName?: string;
        cliPath: string;
        autoRefresh: boolean;
        hooks: boolean;
        index: boolean;
        tools?: "core" | "full";
        agentsMd: boolean;
        claudeMd: boolean;
        claude: boolean;
        policyPack: boolean;
      }
    ) => {
      const result = await initializeProject(repo, {
        autoRefresh: opts.autoRefresh,
        cliPath: opts.cliPath,
        hooks: opts.hooks,
        index: opts.index,
        serverName: opts.serverName,
        toolProfile: opts.tools,
        agentsMd: opts.agentsMd,
        claudeMd: opts.claudeMd,
        claude: opts.claude,
        policyPack: opts.policyPack
      });
      console.log(`Codexa initialized for ${result.repoRoot}`);
      console.log(`Config: ${result.configPath}`);
      if (result.hooksPath) {
        console.log(`Hook: ${result.hooksPath}`);
      }
      if (result.agentsMdPath) {
        console.log(`AGENTS.md: ${result.agentsMdPath}`);
      }
      if (result.claudeMdPath) {
        console.log(`CLAUDE.md: ${result.claudeMdPath}`);
      }
      if (result.claudeMcpPath) {
        console.log(`Claude Code MCP config: ${result.claudeMcpPath}`);
      }
      if (result.policyPack) {
        console.log(`Policy pack: ${result.policyPack.directory}`);
        console.log(`Policy written: ${result.policyPack.written.join(", ") || "none"}`);
        console.log(`Policy skipped: ${result.policyPack.skipped.join(", ") || "none"}`);
      }
      if (result.launchNote) {
        console.log(result.launchNote);
      }
      console.log(`MCP server: ${result.serverName}`);
      if (result.indexed) {
        console.log(`Indexed ${result.indexed.files} files, ${result.indexed.symbols} symbols, ${result.indexed.usageSites} usage sites.`);
      } else {
        console.log("Index: skipped");
      }
      console.log(`Next Codex sessions only need: focus on ${result.repoRoot}`);
    }
  );

program
  .command("autonomy")
  .argument("[repo]", "repository root for a repo-specific user policy; omitted with --global sets the user default")
  .option("--mode <mode>", "set user-owned autonomy mode: read-only or full-access", parseAutonomyOption)
  .option("--global", "set the user default instead of a repo-specific policy", false)
  .option("--json", "print JSON")
  .description("Inspect or set Codexa's user-owned autonomy policy. Repo config cannot enable execution.")
  .action(async (repo: string | undefined, opts: { mode?: ReturnType<typeof parseAutonomyOption>; global: boolean; json?: boolean }) => {
    const repoRoot = repo ? path.resolve(repo) : process.cwd();
    const status = opts.mode
      ? await setAutonomyMode({ repoRoot: opts.global ? undefined : repoRoot, global: opts.global || !repo, mode: opts.mode })
      : opts.global
        ? await defaultAutonomyMode()
        : await effectiveAutonomyMode(repoRoot);
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Codexa autonomy: ${status.mode}`);
    console.log(`Source: ${status.source}`);
    console.log(`Config: ${status.configPath}`);
    if (status.repoRoot) {
      console.log(`Repo: ${status.repoRoot}`);
    }
  });

program
  .command("hook-pre-edit")
  .argument("<repo>", "repository root")
  .description("Cheap hook helper that saves an implicit pre-edit baseline when no change-plan snapshot exists before an edit.")
  .action(async (repo: string) => {
    await runPreEditHook(repo);
  });

program
  .command("hook-post-edit")
  .argument("<repo>", "repository root")
  .description("Bounded hook helper that runs the post-edit review packet after edit tools.")
  .action(async (repo: string) => {
    await runPostEditHook(repo);
  });

program
  .command("index")
  .argument("<repo>", "repository root to index")
  .description("Index a repository and write .codex/codebase artifacts.")
  .action(async (repo: string) => {
    const index = await buildIndexLocked({ repoRoot: path.resolve(repo), writeArtifacts: true });
    console.log(`Indexed ${index.files.length} files, ${index.symbols.length} symbols, ${index.usageSites.length} usage sites.`);
    console.log(`Artifacts: ${path.join(path.resolve(repo), ".codex/codebase")}`);
  });

program
  .command("semantic-index")
  .argument("<repo>", "repository root to embed for first-class hybrid semantic retrieval")
  .requiredOption("--provider <provider>", "embedding provider: openai or local-command", parseSemanticProvider)
  .option("--model <model>", "embedding model name; defaults to provider-specific default")
  .option("--dimensions <n>", "embedding dimensions when the provider supports it", parseIntOption)
  .option("--command <command>", "local embedding command for --provider local-command")
  .option("--arg <arg...>", "argument for the local embedding command; repeat or pass multiple values")
  .option("--timeout-ms <n>", "embedding provider timeout in milliseconds", parseIntOption, 60_000)
  .option("--batch-size <n>", "number of chunks to send per provider request", parseIntOption, 64)
  .option("--max-files <n>", "maximum indexed files to embed", parseIntOption, 750)
  .description("Build the semantic retrieval cache used by first-class hybrid Codexa search and task context.")
  .action(
    async (
      repo: string,
      opts: {
        provider: SemanticProviderKind;
        model?: string;
        dimensions?: number;
        command?: string;
        arg?: string[];
        timeoutMs: number;
        batchSize: number;
        maxFiles: number;
      }
    ) => {
      const repoRoot = path.resolve(repo);
      const index = await buildIndexLocked({ repoRoot, writeArtifacts: true });
      const result = await buildSemanticIndex(repoRoot, index, {
        provider: opts.provider,
        model: opts.model,
        dimensions: opts.dimensions,
        command: opts.command,
        args: opts.arg,
        timeoutMs: opts.timeoutMs,
        batchSize: opts.batchSize,
        maxFiles: opts.maxFiles
      });
      console.log(`Codexa semantic index built for ${result.repoRoot}`);
      console.log(`Provider: ${result.provider}; model: ${result.model}; dimensions: ${result.dimensions}`);
      console.log(`Chunks: ${result.chunkCount}`);
      console.log(`Cache: ${result.cacheDir}`);
    }
  );

program
  .command("watch")
  .argument("<repo>", "repository root to keep indexed")
  .option("--debounce-ms <n>", "milliseconds to wait after detected changes before rebuilding", parseIntOption, 750)
  .option("--poll-ms <n>", "fallback git freshness polling interval in milliseconds", parseIntOption, 2000)
  .option("--initial", "index immediately before watching", true)
  .option("--no-initial", "wait for the next detected change instead of indexing immediately")
  .option("--max-runs <n>", "stop after N index runs; useful for smoke tests and hooks", parseIntOption)
  .description("Keep .codex/codebase artifacts live with debounced filesystem watching plus git freshness polling.")
  .action(async (repo: string, opts: { debounceMs: number; pollMs: number; initial: boolean; maxRuns?: number }) => {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const summary = await runLiveIndexer(path.resolve(repo), {
      debounceMs: opts.debounceMs,
      pollMs: opts.pollMs,
      initial: opts.initial,
      maxRuns: opts.maxRuns,
      signal: controller.signal,
      onEvent: logLiveIndexEvent
    });
    if (summary.runs.length === 0) {
      console.error(`Codexa watch stopped for ${summary.repoRoot}; no index runs completed.`);
    }
  });

program
  .command("static-analysis")
  .argument("<repo>", "repository root")
  .option("--semgrep-report <path...>", "existing Semgrep JSON/SARIF report to copy into .codex/static-analysis")
  .option("--codeql-report <path...>", "existing CodeQL SARIF report to copy into .codex/static-analysis")
  .option("--sarif <path...>", "generic SARIF report to copy into .codex/static-analysis")
  .option("--generic-report <path...>", "generic Codexa risk JSON report to copy into .codex/static-analysis")
  .option("--symbol-report <path...>", "CodexaSymbolReportV1 JSON report to copy into .codex/static-analysis")
  .option("--scip-report <path...>", "SCIP JSON from scip print --json to convert into a Codexa symbol report")
  .option("--run-semgrep", "run an installed Semgrep CLI and ingest JSON output", false)
  .option("--semgrep-config <config...>", "Semgrep config value; repeat or pass multiple values", ["p/default"])
  .option("--run-codeql", "run an installed CodeQL CLI for JavaScript/TypeScript and Python and ingest SARIF output", false)
  .option("--codeql-language <language...>", "CodeQL language ids; supported in Codexa helper: javascript-typescript, python", ["javascript-typescript", "python"])
  .option("--codeql-suite <suite>", "CodeQL suite suffix to use with bundled query packs", "code-scanning")
  .option("--run-shellcheck", "run an installed ShellCheck CLI for tracked shell scripts and ingest findings", false)
  .option("--timeout-ms <n>", "scanner command timeout in milliseconds", parseIntOption, 600_000)
  .option("--index", "reindex after reports are copied or generated", true)
  .option("--no-index", "only copy/generate reports")
  .description("Import risk and symbol/code-intelligence reports, optionally run user-installed scanners, and fold findings into Codexa context.")
  .action(
    async (
      repo: string,
      opts: {
        semgrepReport?: string[];
        codeqlReport?: string[];
        sarif?: string[];
        genericReport?: string[];
        symbolReport?: string[];
        scipReport?: string[];
        runSemgrep: boolean;
        semgrepConfig: string[];
        runCodeql: boolean;
        codeqlLanguage: string[];
        codeqlSuite: string;
        runShellcheck: boolean;
        timeoutMs: number;
        index: boolean;
      }
    ) => {
      const result = await updateStaticAnalysisReports(path.resolve(repo), {
        semgrepReports: opts.semgrepReport,
        codeqlReports: opts.codeqlReport,
        sarifReports: opts.sarif,
        genericReports: opts.genericReport,
        symbolReports: opts.symbolReport,
        scipReports: opts.scipReport,
        runSemgrep: opts.runSemgrep,
        semgrepConfigs: opts.semgrepConfig,
        runCodeql: opts.runCodeql,
        codeqlLanguages: opts.codeqlLanguage,
        codeqlSuite: opts.codeqlSuite,
        runShellcheck: opts.runShellcheck,
        timeoutMs: opts.timeoutMs,
        index: opts.index
      });
      console.log(result.text);
    }
  );

program
  .command("github-sync-check")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .option("--remote <name>", "git remote name to inspect", "origin")
  .option("--branch <branch>", "branch to inspect; defaults to the current branch")
  .option("--no-network", "skip remote ls-remote and push dry-run checks")
  .option("--no-push-check", "skip git push --dry-run")
  .option("--no-gh-check", "skip GitHub CLI detection")
  .option("--json", "emit structured JSON")
  .description("Diagnose whether a Codexa repo is ready for normal authenticated GitHub source sync.")
  .action(
    async (
      repo: string,
      opts: {
        remote: string;
        branch?: string;
        network: boolean;
        pushCheck: boolean;
        ghCheck: boolean;
        json?: boolean;
      }
    ) => {
      const result = await checkGithubSync(path.resolve(repo), {
        remote: opts.remote,
        branch: opts.branch,
        skipNetwork: !opts.network,
        checkPush: opts.pushCheck,
        checkGh: opts.ghCheck
      });
      console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text);
    }
  );

program
  .command("github-release")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .option("--tag <tag>", "release tag; defaults to v<package.json version>")
  .option("--title <title>", "GitHub Release title; defaults to <project name> <tag>")
  .option("--project-name <name>", "project display name for release notes; defaults to package.json name or repo directory")
  .option("--repo <owner/name>", "GitHub repo slug; defaults to origin remote")
  .option("--remote <name>", "git remote name", "origin")
  .option("--branch <branch>", "branch to push; defaults to current branch")
  .option("--latest <mode>", "GitHub latest marker behavior: auto, true, or false", "auto")
  .option("--notes-file <path>", "write generated release notes to a file and stop before git/gh mutation")
  .option("--dry-run", "print intended tag, push, and release actions without mutating git or GitHub", false)
  .option("--push", "push the branch and tag to GitHub", true)
  .option("--no-push", "leave branch and tag local")
  .option("--create-tag", "create the annotated release tag when missing", true)
  .option("--no-create-tag", "require an existing tag and skip tag creation")
  .option("--github-release", "create or update the GitHub Release timeline entry", true)
  .option("--no-github-release", "skip GitHub Release creation/update")
  .option("--allow-dirty", "allow release notes/dry-run while the working tree is dirty", false)
  .option("--allow-non-main", "allow releasing from a branch other than main", false)
  .description("Create a visible GitHub Release with exact continue and forward-only revert commands.")
  .action(
    async (
      repo: string,
      opts: {
        tag?: string;
        title?: string;
        projectName?: string;
        repo?: string;
        remote: string;
        branch?: string;
        latest: "auto" | "true" | "false";
        notesFile?: string;
        dryRun: boolean;
        push: boolean;
        createTag: boolean;
        githubRelease: boolean;
        allowDirty: boolean;
        allowNonMain: boolean;
      }
    ) => {
      const result = await publishProjectGithubRelease(path.resolve(repo), {
        tag: opts.tag,
        title: opts.title,
        projectName: opts.projectName,
        repo: opts.repo,
        remote: opts.remote,
        branch: opts.branch,
        latest: opts.latest,
        notesFile: opts.notesFile,
        dryRun: opts.dryRun,
        push: opts.push,
        createTag: opts.createTag,
        githubRelease: opts.githubRelease,
        allowDirty: opts.allowDirty,
        allowNonMain: opts.allowNonMain
      });
      console.log(result.text);
    }
  );

program
  .command("doctor")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .option("--json", "emit structured JSON")
  .option("--mcp-readiness", "include Codex MCP readiness checks")
  .option("--workspace-focus-file <path>", "workspace focus file to consult when diagnosing a workspace launch root")
  .option("--workspace-session <id>", "active WORKING.md session row to prefer when diagnosing a workspace launch root")
  .description("Diagnose local Codexa wiring, index freshness, hooks, and generated state.")
  .action(async (repo: string, opts: { json?: boolean; mcpReadiness?: boolean; workspaceFocusFile?: string; workspaceSession?: string }) => {
    const result = await runDoctor(path.resolve(repo), {
      json: opts.json,
      mcpReadiness: opts.mcpReadiness,
      workspaceFocusFile: opts.workspaceFocusFile ? path.resolve(opts.workspaceFocusFile) : undefined,
      workspaceSessionId: opts.workspaceSession
    });
    console.log(result.text);
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("policy-init")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .option("--force", "overwrite existing .codex/policies/*.json files", false)
  .description("Write the default local Codexa policy pack consumed by proof cards.")
  .action(async (repo: string, opts: { force: boolean }) => {
    const result = await initializePolicyPack(path.resolve(repo), { force: opts.force });
    console.log(`Codexa policy pack: ${result.directory}`);
    console.log(`Written: ${result.written.join(", ") || "none"}`);
    console.log(`Skipped: ${result.skipped.join(", ") || "none"}`);
  });

program
  .command("prove")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .option("--task <task>", "task description to shape the proof card")
  .option("--task-id <id>", "saved change-plan task id to bind proof to")
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--file <path...>", "target file path for proof-card verification; repeat or pass multiple paths")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 1800)
  .option("--ran-test <test...>", "test file or direct test reference already run; repeat or pass multiple values")
  .option("--ran-command <command...>", "verification command already run; repeat or pass multiple values")
  .option("--ran-command-report <json...>", "structured command report JSON with command, cwd, packageManager, workspace/packageRoot/packageName, scriptName, args, exitCode, durationMs, and output summaries")
  .option("--waive-check <target...>", "legacy test-target waiver shortcut; use --waiver for workflow/dependency checks")
  .option("--waiver <json...>", "structured verification waiver JSON: {\"kind\":\"test\",\"target\":\"tests/foo.test.ts\",\"reason\":\"manual check\"}")
  .option("--json", "emit structured JSON")
  .option("--auto-refresh", "refresh a stale or missing index before proving", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before proving")
  .description("Print a compact proof card: freshness, read-first files, plan snapshot, verification preview, reported evidence, policy pack, and gaps.")
  .action(async (repo: string, opts: { task?: string; taskId?: string; diff: boolean; changeType: ChangeType; file?: string[]; budget: number; ranTest?: string[]; ranCommand?: string[]; ranCommandReport?: string[]; waiveCheck?: string[]; waiver?: string[]; json?: boolean; autoRefresh: boolean }) => {
    const result = await proveQuery(await resolveQueryRepoRoot(repo), {
      task: opts.task,
      taskId: opts.taskId,
      diff: opts.diff,
      changeType: opts.changeType,
      files: opts.file,
      tokenBudget: opts.budget,
      ranTests: opts.ranTest,
      ranCommands: opts.ranCommand,
      ranCommandReports: parseCommandReportOptions(opts.ranCommandReport),
      waivedChecks: opts.waiveCheck,
      waivers: parseWaiverOptions(opts.waiver),
      autoRefresh: opts.autoRefresh
    });
    console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text);
  });

registerQueryCommands(program);

program
  .command("eval")
  .argument("<repo>", "repository root")
  .option("--suite <suite>", "eval suite: all, project, synthetic, historical-fixture, task-pack", "all")
  .option("--seed <seed>", "seed for randomized synthetic holdouts")
  .option("--task-pack <path>", "external historical task pack JSON")
  .option("--json", "emit machine-readable JSON")
  .option("--auto-refresh", "allow eval queries to refresh stale artifacts", false)
  .option("--no-auto-refresh", "keep eval queries frozen against the existing index")
  .option("--fail-on-refresh", "fail a scenario if a query auto-refreshes during scoring", true)
  .option("--no-fail-on-refresh", "record refreshes without failing the scenario")
  .option("--centrality-experiment", "run eval-only transitive centrality/PageRank experiment without changing default rank", false)
  .description("Run a structured Codexa quality benchmark with randomized anti-cheat holdouts.")
  .action(async (repo: string, opts: { suite: "all" | "project" | "synthetic" | "historical-fixture" | "task-pack"; seed?: string; taskPack?: string; json?: boolean; autoRefresh: boolean; failOnRefresh: boolean; centralityExperiment: boolean }) => {
    const result = await runEval(
      await resolveQueryRepoRoot(repo),
      { autoRefresh: opts.autoRefresh },
      { suite: opts.suite, seed: opts.seed, json: opts.json, failOnRefresh: opts.failOnRefresh, taskPackPath: opts.taskPack ? path.resolve(opts.taskPack) : undefined, centralityExperiment: opts.centralityExperiment }
    );
    console.log(result.text);
    if (!result.passed) {
      process.exitCode = 1;
    }
  });

program
  .command("session-start")
  .argument("[repo]", "repository root; defaults to current directory")
  .option("--context", "include a small context preview", false)
  .option("--auto-refresh", "refresh a stale or missing index before rendering the context preview", false)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before rendering the context preview")
  .description("Print the lightweight Codexa SessionStart summary used by Codex hooks.")
  .action(async (repo: string | undefined, opts: { context: boolean; autoRefresh: boolean }) => {
    const resolved = path.resolve(repo ?? process.cwd());
    const startedAt = Date.now();
    const summary = await sessionStartSummary(repo, opts.context || process.env.CODEXA_SESSIONSTART_CONTEXT === "1", opts.autoRefresh);
    console.log(summary);
    const unavailable = summary.includes("Codexa status unavailable:");
    await recordAdvisoryHookEvent(resolved, {
      hook: "session-start",
      status: unavailable ? "failed" : "ok",
      durationMs: Date.now() - startedAt,
      reason: opts.context || process.env.CODEXA_SESSIONSTART_CONTEXT === "1" ? "context-preview" : "status",
      error: unavailable ? summary.split(/\r?\n/u).find((line) => line.includes("Codexa status unavailable:")) : undefined
    });
  });

program
  .command("serve")
  .argument("<repo>", "repository root")
  .option("--semantic", "force semantic retrieval for MCP task queries when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for MCP task queries")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--lsp", "enable optional read-only LSP assist for MCP symbol/file/context calls")
  .option("--lsp-timeout-ms <n>", "LSP request timeout in milliseconds", parseIntOption)
  .option("--lsp-max-files <n>", "maximum files to inspect with LSP assist", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before answering MCP context tools", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before answering MCP context tools")
  .option("--session-memory <mode>", "auto-record MCP session memory: auto or off", parseSessionMemoryMode, "auto")
  .option("--tools <profile>", "server-side tool exposure: core (primary loop only, cheaper per turn) or full", parseToolProfile, "full")
  .option("--workspace-focus-file <path>", "workspace focus file to consult when <repo> is a workspace launch root")
  .option("--workspace-session <id>", "active WORKING.md session row to prefer when <repo> is a workspace launch root")
  .option("--transport <transport>", "MCP transport: stdio or http", parseMcpTransport, "stdio")
  .option("--host <host>", "HTTP host for --transport http; must be loopback", "127.0.0.1")
  .option("--port <n>", "HTTP port for --transport http", parseIntOption, 8729)
  .option("--endpoint <path>", "HTTP MCP endpoint path for --transport http", "/mcp")
  .description("Start the MCP server over stdio by default, or Streamable HTTP with --transport http.")
  .action(async (repo: string, opts: CliQueryOptions & { transport: McpTransportKind; host: string; port: number; endpoint: string; tools: "core" | "full" }) => {
    const resolved = path.resolve(repo);
    const queryOptions = { ...queryOptionsFromCli(opts), toolProfile: opts.tools };
    if (opts.transport === "http") {
      await serveMcpHttp(resolved, queryOptions, { host: opts.host, port: opts.port, endpoint: opts.endpoint });
      return;
    }
    await serveMcp(resolved, queryOptions);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
