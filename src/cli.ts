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
import { runLiveIndexer, type LiveIndexEvent } from "./live-index.js";
import { serveMcp, serveMcpHttp, type McpTransportKind } from "./mcp.js";
import { resolveMcpRepoRoot } from "./mcp-repo-root.js";
import { buildSemanticIndex, semanticProviderFromValue, type SemanticProviderKind } from "./semantic-retrieval.js";
import { updateStaticAnalysisReports } from "./static-analysis.js";
import { recordAdvisoryHookEvent, runPostEditHook, runPreEditHook } from "./cli/hooks.js";
import {
  contextPackQuery,
  callersQuery,
  calleesQuery,
  changePlanQuery,
  dependencyPathQuery,
  diffImpactQuery,
  fileContextQuery,
  findContextQuery,
  focusBriefQuery,
  impactQuery,
  placeholderReportQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  sessionMemoryQuery,
  statusQuery,
  symbolContextQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "./queries.js";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "./query/raw-search.js";
import type { ChangeType, QueryOptions, SessionMemoryInput, VerificationCommandReport, VerificationWaiver } from "./types.js";
import { runEval } from "./eval.js";
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
      }
    ) => {
      const result = await initializeProject(repo, {
        autoRefresh: opts.autoRefresh,
        cliPath: opts.cliPath,
        hooks: opts.hooks,
        index: opts.index,
        serverName: opts.serverName
      });
      console.log(`Codexa initialized for ${result.repoRoot}`);
      console.log(`Config: ${result.configPath}`);
      if (result.hooksPath) {
        console.log(`Hook: ${result.hooksPath}`);
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
  .description("Cheap hook helper that reminds Codex when no change-plan snapshot exists before an edit.")
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
  .option("--run-semgrep", "run an installed Semgrep CLI and ingest JSON output", false)
  .option("--semgrep-config <config...>", "Semgrep config value; repeat or pass multiple values", ["p/default"])
  .option("--run-codeql", "run an installed CodeQL CLI for JavaScript/TypeScript and Python and ingest SARIF output", false)
  .option("--codeql-language <language...>", "CodeQL language ids; supported in Codexa helper: javascript-typescript, python", ["javascript-typescript", "python"])
  .option("--codeql-suite <suite>", "CodeQL suite suffix to use with bundled query packs", "code-scanning")
  .option("--run-shellcheck", "run an installed ShellCheck CLI for tracked shell scripts and ingest findings", false)
  .option("--timeout-ms <n>", "scanner command timeout in milliseconds", parseIntOption, 600_000)
  .option("--index", "reindex after reports are copied or generated", true)
  .option("--no-index", "only copy/generate reports")
  .description("Import Semgrep/CodeQL/SARIF risk reports, optionally run user-installed scanners, and fold findings into Codexa context.")
  .action(
    async (
      repo: string,
      opts: {
        semgrepReport?: string[];
        codeqlReport?: string[];
        sarif?: string[];
        genericReport?: string[];
        symbolReport?: string[];
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
  .command("status")
  .argument("<repo>", "repository root")
  .description("Report Codexa index freshness and parser status.")
  .action(async (repo: string) => printQuery(await statusQuery(await resolveQueryRepoRoot(repo))));

program
  .command("repo-map")
  .argument("<repo>", "repository root")
  .option("--limit <n>", "maximum files/modules to return", parseIntOption, 20)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 1500)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Print the top-ranked repo map, refreshing stale artifacts when needed.")
  .action(async (repo: string, opts: { limit: number; budget: number; autoRefresh: boolean }) =>
    printQuery(await repoMapQuery(await resolveQueryRepoRoot(repo), opts.limit, { autoRefresh: opts.autoRefresh }, opts.budget))
  );

program
  .command("find-context")
  .argument("<repo>", "repository root")
  .requiredOption("--query <query>", "search query")
  .option("--limit <n>", "maximum matches", parseIntOption, 12)
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Find matching files, symbols, and usage sites.")
  .action(async (repo: string, opts: { query: string; limit: number } & CliQueryOptions) =>
    printQuery(await findContextQuery(await resolveQueryRepoRoot(repo), opts.query, opts.limit, queryOptionsFromCli(opts)))
  );

program
  .command("search")
  .argument("<repo>", "repository root")
  .requiredOption("--query <query>", "search query")
  .option("--pattern <pattern...>", `additional literal raw-search patterns; pass up to ${RAW_SEARCH_EXPLICIT_PATTERN_LIMIT} variants with the query`)
  .option("--limit <n>", "maximum matches", parseIntOption, 12)
  .option("--raw", "include raw hit lines", true)
  .option("--no-raw", "summarize raw hit files without lines")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Run first-class hybrid semantic search over raw hits, Codexa ranking, tests, and known gaps.")
  .action(async (repo: string, opts: { query: string; pattern?: string[]; limit: number; raw: boolean } & CliQueryOptions) =>
    printQuery(
      await searchQuery(
        await resolveQueryRepoRoot(repo),
        { query: opts.query, patterns: opts.pattern, limit: opts.limit, includeRaw: opts.raw },
        queryOptionsFromCli(opts)
      )
    )
  );

program
  .command("placeholder-report")
  .argument("<repo>", "repository root")
  .option("--include-tests", "include test files in placeholder findings", false)
  .option("--include-docs", "include documentation files in placeholder findings", false)
  .option("--include-generated", "include generated files in placeholder findings", false)
  .option("--limit <n>", "maximum findings", parseIntOption, 40)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2400)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Report indexed placeholder, dummy, TODO, and stub code/data findings.")
  .action(async (repo: string, opts: { includeTests: boolean; includeDocs: boolean; includeGenerated: boolean; limit: number; budget: number; autoRefresh: boolean }) =>
    printQuery(
      await placeholderReportQuery(
        await resolveQueryRepoRoot(repo),
        {
          includeTests: opts.includeTests,
          includeDocs: opts.includeDocs,
          includeGenerated: opts.includeGenerated,
          limit: opts.limit,
          tokenBudget: opts.budget
        },
        { autoRefresh: opts.autoRefresh }
      )
    )
  );

program
  .command("explain")
  .argument("<repo>", "repository root")
  .option("--file <path>", "file to explain")
  .option("--symbol <symbol>", "symbol id or name to explain")
  .option("--depth <n>", "symbol neighborhood depth, 1-3", parseIntOption)
  .option("--language <language>", "optional symbol language filter")
  .option("--no-evidence", "omit compact edge evidence from symbol_context output")
  .option("--lsp", "include optional read-only LSP assist for TypeScript, JavaScript, or Python")
  .option("--lsp-timeout-ms <n>", "LSP request timeout in milliseconds", parseIntOption)
  .option("--lsp-max-files <n>", "maximum files to inspect with LSP assist", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Return compact evidence for a file or symbol.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; depth?: number; language?: string; evidence?: boolean } & CliQueryOptions) => {
    const queryOptions = queryOptionsFromCli(opts);
    const repoRoot = await resolveQueryRepoRoot(repo);
    if (opts.symbol) {
      printQuery(await symbolContextQuery(repoRoot, opts.symbol, queryOptions, { depth: opts.depth, language: opts.language, includeEvidence: opts.evidence }));
      return;
    }
    if (opts.file) {
      printQuery(await fileContextQuery(repoRoot, opts.file, queryOptions));
      return;
    }
    throw new Error("explain requires --file or --symbol");
  });

program
  .command("impact")
  .argument("<repo>", "repository root")
  .option("--file <path>", "file to analyze")
  .option("--symbol <symbol>", "symbol id or name to analyze")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--depth <n>", "import/test traversal depth, 1-3; default is adaptive by change type", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Return blast-radius evidence for a file or symbol.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; changeType: ChangeType; depth?: number; autoRefresh: boolean }) => {
    if (!opts.file && !opts.symbol) {
      throw new Error("impact requires --file or --symbol");
    }
    printQuery(await impactQuery(await resolveQueryRepoRoot(repo), opts, { autoRefresh: opts.autoRefresh }));
  });

program
  .command("diff-impact")
  .argument("<repo>", "repository root")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Return impact context for the current dirty git diff.")
  .action(async (repo: string, opts: { autoRefresh: boolean }) =>
    printQuery(await diffImpactQuery(await resolveQueryRepoRoot(repo), { autoRefresh: opts.autoRefresh }))
  );

program
  .command("test-plan")
  .argument("<repo>", "repository root")
  .option("--diff", "use current dirty git diff", true)
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Recommend targeted tests.")
  .action(async (repo: string, opts: { diff: boolean; changeType: ChangeType; autoRefresh: boolean }) =>
    printQuery(
      await testPlanQuery(await resolveQueryRepoRoot(repo), opts.diff, {
        autoRefresh: opts.autoRefresh,
        changeType: opts.changeType
      })
    )
  );

program
  .command("brief")
  .argument("<repo>", "repository root")
  .option("--task <task>", "task description to shape the brief")
  .option("--file <path...>", "focus file path; repeat or pass multiple paths")
  .option("--symbol <symbol...>", "focus symbol id, qualified name, or unique name")
  .option("--query <query>", "search query to seed context")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 3000)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--snippets", "include source snippets", true)
  .option("--no-snippets", "omit source snippets")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--lsp", "include optional read-only LSP assist for selected focus files")
  .option("--lsp-timeout-ms <n>", "LSP request timeout in milliseconds", parseIntOption)
  .option("--lsp-max-files <n>", "maximum files to inspect with LSP assist", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Build the default Codex-first task brief with bounded impact, risks, tests, freshness, and snippets.")
  .action(
    async (
      repo: string,
      opts: {
        task?: string;
        file?: string[];
        symbol?: string[];
        query?: string;
        changeType: ChangeType;
        diff: boolean;
        budget: number;
        limit: number;
        snippets: boolean;
      } & CliQueryOptions
    ) =>
      printQuery(
        await taskBriefQuery(
          await resolveQueryRepoRoot(repo),
          {
            task: opts.task,
            files: opts.file,
            symbols: opts.symbol,
            query: opts.query,
            changeType: opts.changeType,
            diff: opts.diff,
            tokenBudget: opts.budget,
            limit: opts.limit,
            includeSnippets: opts.snippets
          },
          queryOptionsFromCli(opts)
        )
      )
  );

program
  .command("context-pack")
  .argument("<repo>", "repository root")
  .option("--task <task>", "task description to shape the context pack")
  .option("--file <path...>", "focus file path; repeat or pass multiple paths")
  .option("--symbol <symbol...>", "focus symbol id, qualified name, or unique name")
  .option("--query <query>", "search query to seed context")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 4000)
  .option("--limit <n>", "maximum focus items", parseIntOption, 12)
  .option("--snippets", "include source snippets", true)
  .option("--no-snippets", "omit source snippets")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--lsp", "include optional read-only LSP assist for selected focus files")
  .option("--lsp-timeout-ms <n>", "LSP request timeout in milliseconds", parseIntOption)
  .option("--lsp-max-files <n>", "maximum files to inspect with LSP assist", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Build a compact task-shaped Codexa context pack.")
  .action(
    async (
      repo: string,
      opts: {
        task?: string;
        file?: string[];
        symbol?: string[];
        query?: string;
        changeType: ChangeType;
        diff: boolean;
        budget: number;
        limit: number;
        snippets: boolean;
      } & CliQueryOptions
    ) =>
      printQuery(
        await contextPackQuery(
          await resolveQueryRepoRoot(repo),
          {
            task: opts.task,
            files: opts.file,
            symbols: opts.symbol,
            query: opts.query,
            changeType: opts.changeType,
            diff: opts.diff,
            tokenBudget: opts.budget,
            limit: opts.limit,
            includeSnippets: opts.snippets
          },
          queryOptionsFromCli(opts)
        )
      )
  );

program
  .command("focus-brief")
  .argument("<repo>", "repository root")
  .option("--task <task>", "natural-language task to classify and focus")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2400)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Classify a broad task, choose likely subsystems, and recommend the next Codexa call.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean } & CliQueryOptions) =>
    printQuery(await focusBriefQuery(await resolveQueryRepoRoot(repo), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, queryOptionsFromCli(opts)))
  );

program
  .command("session-context")
  .argument("<repo>", "repository root")
  .option("--task <task>", "optional task to shape startup context")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2400)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Print the Codexa focus/session packet used when Codex focuses a project.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean } & CliQueryOptions) =>
    printQuery(await focusBriefQuery(await resolveQueryRepoRoot(repo), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, queryOptionsFromCli(opts)))
  );

program
  .command("session-memory")
  .argument("<repo>", "repository root")
  .option("--action <action>", "summary, read, remember, or compact", parseSessionMemoryAction, "summary")
  .option("--session-id <id>", "session memory id; defaults to the latest local session")
  .option("--task-id <id>", "task snapshot id to filter or attach memory")
  .option("--task <task>", "task text to attach to remembered entries")
  .option("--kind <kind...>", "memory kind filter; repeat or pass multiple values")
  .option("--file <path...>", "file scope filter; repeat or pass multiple values")
  .option("--symbol <symbol...>", "symbol id scope filter; repeat or pass multiple values")
  .option("--topic <topic...>", "topic substring filter; repeat or pass multiple values")
  .option("--entry-json <json...>", "entry JSON for --action remember; repeat for multiple entries")
  .option("--limit <n>", "maximum entries", parseIntOption, 20)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 1800)
  .option("--include-stale", "include stale entries", true)
  .option("--no-include-stale", "hide stale entries")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Read, summarize, compact, or explicitly remember Codexa session working memory.")
  .action(
    async (
      repo: string,
      opts: {
        action: NonNullable<SessionMemoryInput["action"]>;
        sessionId?: string;
        taskId?: string;
        task?: string;
        kind?: string[];
        file?: string[];
        symbol?: string[];
        topic?: string[];
        entryJson?: string[];
        limit: number;
        budget: number;
        includeStale: boolean;
      } & CliQueryOptions
    ) =>
      printQuery(
        await sessionMemoryQuery(
          await resolveQueryRepoRoot(repo),
          {
            action: opts.action,
            sessionId: opts.sessionId,
            taskId: opts.taskId,
            task: opts.task,
            kinds: parseSessionMemoryKinds(opts.kind),
            files: opts.file,
            symbols: opts.symbol,
            topics: opts.topic,
            entries: parseSessionMemoryEntries(opts.entryJson),
            limit: opts.limit,
            tokenBudget: opts.budget,
            includeStale: opts.includeStale
          },
          queryOptionsFromCli(opts)
        )
      )
  );

program
  .command("callers")
  .argument("<repo>", "repository root")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol id, qualified name, or unique name")
  .option("--limit <n>", "maximum graph edges", parseIntOption, 20)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Show graph callers, importers, references, and tests for a target.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await callersQuery(await resolveQueryRepoRoot(repo), opts, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("callees")
  .argument("<repo>", "repository root")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol id, qualified name, or unique name")
  .option("--limit <n>", "maximum graph edges", parseIntOption, 20)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Show graph callees, dependencies, imports, and risk surfaces for a target.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await calleesQuery(await resolveQueryRepoRoot(repo), opts, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("dependency-path")
  .argument("<repo>", "repository root")
  .option("--from-file <path>", "source file")
  .option("--from-symbol <symbol>", "source symbol")
  .option("--to-file <path>", "target file")
  .option("--to-symbol <symbol>", "target symbol")
  .option("--max-depth <n>", "maximum graph depth", parseIntOption, 6)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Find a typed dependency path between files or symbols.")
  .action(async (repo: string, opts: { fromFile?: string; fromSymbol?: string; toFile?: string; toSymbol?: string; maxDepth: number; autoRefresh: boolean }) =>
    printQuery(await dependencyPathQuery(await resolveQueryRepoRoot(repo), opts, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("workflow-path")
  .argument("<repo>", "repository root")
  .option("--query <query>", "natural-language workflow query")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol")
  .option("--limit <n>", "maximum workflow traces", parseIntOption, 8)
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Show route/job/manifest workflow traces related to a task, file, or symbol.")
  .action(async (repo: string, opts: { query?: string; file?: string; symbol?: string; limit: number } & CliQueryOptions) =>
    printQuery(await workflowPathQuery(await resolveQueryRepoRoot(repo), opts, queryOptionsFromCli(opts)))
  );

program
  .command("change-plan")
  .argument("<repo>", "repository root")
  .option("--task <task>", "task description")
  .option("--file <path...>", "focus file path; repeat or pass multiple paths")
  .option("--symbol <symbol...>", "focus symbol id, qualified name, or unique name")
  .option("--query <query>", "search query to seed context")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 3200)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--save-snapshot", "save a plan-time task snapshot for post-edit review", false)
  .option("--task-id <id>", "optional id for the saved task snapshot")
  .option("--follow-candidate <id>", "follow an edit-ready target candidate from a blocked orientation plan")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this query")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--lsp", "include optional read-only LSP assist for selected focus files")
  .option("--lsp-timeout-ms <n>", "LSP request timeout in milliseconds", parseIntOption)
  .option("--lsp-max-files <n>", "maximum files to inspect with LSP assist", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Build a Codex edit plan from focus, graph/workflow context, risks, tests, and gaps.")
  .action(
    async (
      repo: string,
      opts: {
        task?: string;
        file?: string[];
        symbol?: string[];
        query?: string;
        changeType: ChangeType;
        diff: boolean;
        budget: number;
        limit: number;
        saveSnapshot: boolean;
        taskId?: string;
        followCandidate?: string;
      } & CliQueryOptions
    ) =>
      printQuery(
        await changePlanQuery(
          await resolveQueryRepoRoot(repo),
          {
            task: opts.task,
            files: opts.file,
            symbols: opts.symbol,
            query: opts.query,
            changeType: opts.changeType,
            diff: opts.diff,
            tokenBudget: opts.budget,
            limit: opts.limit,
            saveSnapshot: opts.saveSnapshot,
            taskId: opts.taskId,
            followCandidate: opts.followCandidate
          },
          queryOptionsFromCli(opts)
        )
      )
  );

program
  .command("post-edit-review")
  .alias("post-edit")
  .argument("<repo>", "repository root")
  .option("--task <task>", "task description if no saved snapshot is available")
  .option("--task-id <id>", "task snapshot id; defaults to the latest saved snapshot")
  .option("--file <path...>", "additional edited or focus file path")
  .option("--symbol <symbol...>", "additional focus symbol id, qualified name, or unique name")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2800)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--snippets", "include source snippets", false)
  .option("--no-snippets", "omit source snippets")
  .option("--ran-test <test...>", "test file or direct test reference already run; repeat or pass multiple values")
  .option("--ran-command <command...>", "verification command already run; repeat or pass multiple values")
  .option("--ran-command-report <json...>", "structured command report JSON with command, cwd, packageManager, workspace/packageRoot/packageName, scriptName, args, exitCode, durationMs, and output summaries")
  .option("--waive-check <target...>", "legacy test-target waiver shortcut; use --waiver for workflow/dependency checks")
  .option("--waiver <json...>", "structured verification waiver JSON: {\"kind\":\"test\",\"target\":\"tests/foo.test.ts\",\"reason\":\"manual check\"}")
  .option("--semantic", "force the semantic retrieval lane even when auto-detection would skip it")
  .option("--no-semantic", "disable automatic semantic retrieval for this review")
  .option("--semantic-provider <provider>", "semantic query provider: openai or local-command", parseSemanticProvider)
  .option("--semantic-model <model>", "semantic embedding model name")
  .option("--semantic-dimensions <n>", "semantic embedding dimensions", parseIntOption)
  .option("--semantic-command <command>", "local semantic embedding command for --semantic-provider local-command")
  .option("--semantic-arg <arg...>", "argument for the local semantic embedding command")
  .option("--semantic-timeout-ms <n>", "semantic query timeout in milliseconds", parseIntOption)
  .option("--semantic-batch-size <n>", "semantic query batch size", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Compare the current dirty tree against a saved Codexa change-plan snapshot.")
  .action(
    async (
      repo: string,
      opts: {
        task?: string;
        taskId?: string;
        file?: string[];
        symbol?: string[];
        changeType: ChangeType;
        budget: number;
        limit: number;
        snippets: boolean;
        ranTest?: string[];
        ranCommand?: string[];
        ranCommandReport?: string[];
        waiveCheck?: string[];
        waiver?: string[];
        autoRefresh: boolean;
      } & CliQueryOptions
    ) =>
      printQuery(
        await postEditReviewQuery(
          await resolveQueryRepoRoot(repo),
          {
            task: opts.task,
            taskId: opts.taskId,
            files: opts.file,
            symbols: opts.symbol,
            changeType: opts.changeType,
            tokenBudget: opts.budget,
            limit: opts.limit,
            includeSnippets: opts.snippets,
            ranTests: opts.ranTest,
            ranCommands: opts.ranCommand,
            ranCommandReports: parseCommandReportOptions(opts.ranCommandReport),
            waivedChecks: opts.waiveCheck,
            waivers: parseWaiverOptions(opts.waiver)
          },
          queryOptionsFromCli(opts)
        )
      )
  );

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
  .option("--workspace-focus-file <path>", "workspace focus file to consult when <repo> is a workspace launch root")
  .option("--workspace-session <id>", "active WORKING.md session row to prefer when <repo> is a workspace launch root")
  .option("--transport <transport>", "MCP transport: stdio or http", parseMcpTransport, "stdio")
  .option("--host <host>", "HTTP host for --transport http; must be loopback", "127.0.0.1")
  .option("--port <n>", "HTTP port for --transport http", parseIntOption, 8729)
  .option("--endpoint <path>", "HTTP MCP endpoint path for --transport http", "/mcp")
  .description("Start the MCP server over stdio by default, or Streamable HTTP with --transport http.")
  .action(async (repo: string, opts: CliQueryOptions & { transport: McpTransportKind; host: string; port: number; endpoint: string }) => {
    const resolved = path.resolve(repo);
    const queryOptions = queryOptionsFromCli(opts);
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

function printQuery(result: { text: string }) {
  console.log(result.text);
}

async function resolveQueryRepoRoot(repo: string): Promise<string> {
  return (await resolveMcpRepoRoot(path.resolve(repo))).repoRoot;
}

function invokedCliName(): string {
  const basename = path.basename(process.argv[1] ?? "codexa").replace(/\.[cm]?[jt]sx?$/u, "");
  return basename && basename !== "cli" ? basename : "codexa";
}

type CliQueryOptions = {
  autoRefresh?: boolean;
  semantic?: boolean;
  semanticProvider?: SemanticProviderKind;
  semanticModel?: string;
  semanticDimensions?: number;
  semanticCommand?: string;
  semanticArg?: string[];
  semanticTimeoutMs?: number;
  semanticBatchSize?: number;
  lsp?: boolean;
  lspTimeoutMs?: number;
  lspMaxFiles?: number;
  sessionMemory?: "auto" | "off";
  workspaceFocusFile?: string;
  workspaceSession?: string;
};

function queryOptionsFromCli(opts: CliQueryOptions): QueryOptions {
  return {
    autoRefresh: opts.autoRefresh,
    semantic: opts.semantic,
    semanticProvider: opts.semanticProvider,
    semanticModel: opts.semanticModel,
    semanticDimensions: opts.semanticDimensions,
    semanticCommand: opts.semanticCommand,
    semanticArgs: opts.semanticArg,
    semanticTimeoutMs: opts.semanticTimeoutMs,
    semanticBatchSize: opts.semanticBatchSize,
    lsp: opts.lsp,
    lspTimeoutMs: opts.lspTimeoutMs,
    lspMaxFiles: opts.lspMaxFiles,
    sessionMemory: opts.sessionMemory,
    workspaceFocusFile: opts.workspaceFocusFile ? path.resolve(opts.workspaceFocusFile) : undefined,
    workspaceSessionId: opts.workspaceSession
  };
}

function parseSessionMemoryMode(value: string): "auto" | "off" {
  if (value === "auto" || value === "off") {
    return value;
  }
  throw new Error("session memory mode must be auto or off");
}

function parseMcpTransport(value: string): McpTransportKind {
  if (value === "stdio" || value === "http") {
    return value;
  }
  throw new Error("MCP transport must be stdio or http");
}

function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseAutonomyOption(value: string) {
  return parseAutonomyMode(value);
}

function parseChangeType(value: string): ChangeType {
  const allowed = new Set<ChangeType>(["style", "api", "behavior", "rename", "delete", "unknown"]);
  if (allowed.has(value as ChangeType)) {
    return value as ChangeType;
  }
  throw new Error(`Invalid change type: ${value}`);
}

function parseSessionMemoryAction(value: string): NonNullable<SessionMemoryInput["action"]> {
  const allowed = new Set<NonNullable<SessionMemoryInput["action"]>>(["read", "remember", "summary", "compact"]);
  if (allowed.has(value as NonNullable<SessionMemoryInput["action"]>)) {
    return value as NonNullable<SessionMemoryInput["action"]>;
  }
  throw new Error(`Invalid session memory action: ${value}`);
}

function parseSessionMemoryKinds(values: string[] | undefined): SessionMemoryInput["kinds"] | undefined {
  return values?.map(parseSessionMemoryKind);
}

function parseSessionMemoryKind(value: string): NonNullable<SessionMemoryInput["kinds"]>[number] {
  const allowed = new Set<NonNullable<SessionMemoryInput["kinds"]>[number]>([
    "viewed",
    "claim",
    "ruled_out",
    "open_question",
    "next_read",
    "decision",
    "verification",
    "risk",
    "constraint"
  ]);
  if (allowed.has(value as NonNullable<SessionMemoryInput["kinds"]>[number])) {
    return value as NonNullable<SessionMemoryInput["kinds"]>[number];
  }
  throw new Error(`Invalid session memory kind: ${value}`);
}

function parseSessionMemoryEntries(values: string[] | undefined): SessionMemoryInput["entries"] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invalid session memory entry JSON: ${value}`);
    }
    if (!isCliRecord(parsed)) {
      throw new Error(`Invalid session memory entry JSON: ${value}`);
    }
    const entry = parsed as NonNullable<SessionMemoryInput["entries"]>[number];
    if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) {
      throw new Error(`Invalid session memory entry JSON: summary is required`);
    }
    const kind = parseSessionMemoryKind(String(entry.kind));
    if (entry.confidence !== "authoritative" && entry.confidence !== "derived" && entry.confidence !== "heuristic") {
      throw new Error(`Invalid session memory entry JSON: confidence is required`);
    }
    if (entry.evidenceTier !== "authoritative" && entry.evidenceTier !== "derived" && entry.evidenceTier !== "heuristic" && entry.evidenceTier !== "fallback") {
      throw new Error(`Invalid session memory entry JSON: evidenceTier is required`);
    }
    return {
      ...entry,
      kind,
      summary: entry.summary.trim()
    };
  });
}

function parseSemanticProvider(value: string): SemanticProviderKind {
  const provider = semanticProviderFromValue(value);
  if (!provider) {
    throw new Error(`Invalid semantic provider: ${value}`);
  }
  return provider;
}

function parseWaiverOptions(values: string[] | undefined): VerificationWaiver[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: Partial<VerificationWaiver>;
    try {
      parsed = JSON.parse(value) as Partial<VerificationWaiver>;
    } catch {
      throw new Error(`Invalid waiver JSON: ${value}`);
    }
    if ((parsed.kind !== "test" && parsed.kind !== "workflow" && parsed.kind !== "dependency") || typeof parsed.target !== "string" || typeof parsed.reason !== "string") {
      throw new Error(`Invalid waiver JSON: ${value}`);
    }
    return { kind: parsed.kind, target: parsed.target, reason: parsed.reason };
  });
}

function isCliRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseCommandReportOptions(values: string[] | undefined): VerificationCommandReport[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return values.map((value) => {
    let parsed: Partial<VerificationCommandReport>;
    try {
      parsed = JSON.parse(value) as Partial<VerificationCommandReport>;
    } catch {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (typeof parsed.command !== "string" || parsed.command.trim().length === 0) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.cwd !== undefined && typeof parsed.cwd !== "string") {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    for (const field of ["packageManager", "workspace", "packageRoot", "packageName", "scriptName"] as const) {
      if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
        throw new Error(`Invalid command report JSON: ${value}`);
      }
    }
    if (parsed.args !== undefined && (!Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.args !== undefined && parsed.args.length > 80) {
      throw new Error(`Invalid command report JSON: args exceeds 80 entries`);
    }
    if (parsed.exitCode !== undefined && (!Number.isInteger(parsed.exitCode) || parsed.exitCode < 0)) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    if (parsed.durationMs !== undefined && (!Number.isFinite(parsed.durationMs) || parsed.durationMs < 0)) {
      throw new Error(`Invalid command report JSON: ${value}`);
    }
    for (const field of ["stdoutSummary", "stderrSummary", "outputSummary"] as const) {
      if (parsed[field] !== undefined && typeof parsed[field] !== "string") {
        throw new Error(`Invalid command report JSON: ${value}`);
      }
      if (typeof parsed[field] === "string" && parsed[field].length > 1000) {
        throw new Error(`Invalid command report JSON: ${field} exceeds 1000 characters`);
      }
    }
    return {
      command: parsed.command,
      cwd: parsed.cwd,
      packageManager: parsed.packageManager,
      workspace: parsed.workspace,
      packageRoot: parsed.packageRoot,
      packageName: parsed.packageName,
      scriptName: parsed.scriptName,
      args: parsed.args,
      exitCode: parsed.exitCode,
      durationMs: parsed.durationMs,
      stdoutSummary: parsed.stdoutSummary,
      stderrSummary: parsed.stderrSummary,
      outputSummary: parsed.outputSummary
    };
  });
}

function logLiveIndexEvent(event: LiveIndexEvent): void {
  if (event.type === "watch-ready") {
    console.error(`Codexa watch ready: ${event.repoRoot} (${event.directories} dirs, debounce ${event.debounceMs}ms, poll ${event.pollMs}ms)`);
    return;
  }
  if (event.type === "index-start") {
    console.error(`Codexa indexing started (${event.reason}).`);
    return;
  }
  if (event.type === "index-complete") {
    console.error(`Codexa indexed ${event.files} files, ${event.symbols} symbols, ${event.usageSites} usage sites in ${event.durationMs}ms (${event.reason}).`);
    return;
  }
  if (event.type === "watch-warning") {
    console.error(`Codexa watch warning: ${event.message}`);
    return;
  }
  if (event.type === "watch-stopped") {
    console.error(`Codexa watch stopped after ${event.runs} index run(s).`);
  }
}
