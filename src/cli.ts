#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexLocked } from "./indexer.js";
import { checkGithubSync } from "./github-sync.js";
import { initializeProject, sessionStartSummary } from "./init.js";
import { runLiveIndexer, type LiveIndexEvent } from "./live-index.js";
import { serveMcp } from "./mcp.js";
import { updateStaticAnalysisReports } from "./static-analysis.js";
import { loadTaskSnapshot } from "./task-snapshots.js";
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
  statusQuery,
  symbolContextQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "./queries.js";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "./query/raw-search.js";
import type { ChangeType, VerificationCommandReport, VerificationWaiver } from "./types.js";
import { runEval } from "./eval.js";

const program = new Command();
const cliModulePath = fileURLToPath(import.meta.url);
const defaultCliPath = cliModulePath.endsWith(`${path.sep}src${path.sep}cli.ts`)
  ? path.resolve(path.dirname(cliModulePath), "../dist/cli.js")
  : cliModulePath;

program
  .name(invokedCliName())
  .description("Codex-native codebase intelligence context compiler and MCP context server.")
  .version("0.1.0");

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
  .command("hook-pre-edit")
  .argument("<repo>", "repository root")
  .description("Cheap hook helper that reminds Codex when no change-plan snapshot exists before an edit.")
  .action(async (repo: string) => {
    await runAdvisoryHook("change-plan snapshot check", async () => {
      const resolved = path.resolve(repo);
      const snapshot = await loadTaskSnapshot(resolved);
      if (!snapshot.snapshot) {
        console.log("Codexa: no change-plan snapshot is available. For code edits, call change_plan with saveSnapshot=true before editing when the task is non-trivial.");
        return;
      }
      console.log(`Codexa: change-plan snapshot ready (${snapshot.snapshot.taskId}). After edits, post_edit_review will compare planned vs actual work.`);
    });
  });

program
  .command("hook-post-edit")
  .argument("<repo>", "repository root")
  .description("Bounded hook helper that runs the post-edit review packet after edit tools.")
  .action(async (repo: string) => {
    await runAdvisoryHook("post-edit review", async () => {
      const result = await postEditReviewQuery(
        path.resolve(repo),
        {
          tokenBudget: 1200,
          limit: 5,
          includeSnippets: false
        },
        { autoRefresh: true, commandBudgetMs: 15_000, maxResults: 6 }
      );
      console.log(compactHookOutput(result.text));
    });
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
  .option("--run-semgrep", "run an installed Semgrep CLI and ingest JSON output", false)
  .option("--semgrep-config <config...>", "Semgrep config value; repeat or pass multiple values", ["p/default"])
  .option("--run-codeql", "run an installed CodeQL CLI for JavaScript/TypeScript and Python and ingest SARIF output", false)
  .option("--codeql-language <language...>", "CodeQL language ids; supported in Codexa helper: javascript-typescript, python", ["javascript-typescript", "python"])
  .option("--codeql-suite <suite>", "CodeQL suite suffix to use with bundled query packs", "code-scanning")
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
        runSemgrep: boolean;
        semgrepConfig: string[];
        runCodeql: boolean;
        codeqlLanguage: string[];
        codeqlSuite: string;
        timeoutMs: number;
        index: boolean;
      }
    ) => {
      const result = await updateStaticAnalysisReports(path.resolve(repo), {
        semgrepReports: opts.semgrepReport,
        codeqlReports: opts.codeqlReport,
        sarifReports: opts.sarif,
        genericReports: opts.genericReport,
        runSemgrep: opts.runSemgrep,
        semgrepConfigs: opts.semgrepConfig,
        runCodeql: opts.runCodeql,
        codeqlLanguages: opts.codeqlLanguage,
        codeqlSuite: opts.codeqlSuite,
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
  .command("status")
  .argument("<repo>", "repository root")
  .description("Report Codexa index freshness and parser status.")
  .action(async (repo: string) => printQuery(await statusQuery(path.resolve(repo))));

program
  .command("repo-map")
  .argument("<repo>", "repository root")
  .option("--limit <n>", "maximum files/modules to return", parseIntOption, 20)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 1500)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Print the top-ranked repo map, refreshing stale artifacts when needed.")
  .action(async (repo: string, opts: { limit: number; budget: number; autoRefresh: boolean }) =>
    printQuery(await repoMapQuery(path.resolve(repo), opts.limit, { autoRefresh: opts.autoRefresh }, opts.budget))
  );

program
  .command("find-context")
  .argument("<repo>", "repository root")
  .requiredOption("--query <query>", "search query")
  .option("--limit <n>", "maximum matches", parseIntOption, 12)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Find matching files, symbols, and usage sites.")
  .action(async (repo: string, opts: { query: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await findContextQuery(path.resolve(repo), opts.query, opts.limit, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("search")
  .argument("<repo>", "repository root")
  .requiredOption("--query <query>", "search query")
  .option("--pattern <pattern...>", `additional literal raw-search patterns; pass up to ${RAW_SEARCH_EXPLICIT_PATTERN_LIMIT} variants with the query`)
  .option("--limit <n>", "maximum matches", parseIntOption, 12)
  .option("--raw", "include raw hit lines", true)
  .option("--no-raw", "summarize raw hit files without lines")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Compare raw search with Codexa-ranked targets, tests, and known gaps.")
  .action(async (repo: string, opts: { query: string; pattern?: string[]; limit: number; raw: boolean; autoRefresh: boolean }) =>
    printQuery(
      await searchQuery(
        path.resolve(repo),
        { query: opts.query, patterns: opts.pattern, limit: opts.limit, includeRaw: opts.raw },
        { autoRefresh: opts.autoRefresh }
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
        path.resolve(repo),
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
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Return compact evidence for a file or symbol.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; autoRefresh: boolean }) => {
    const queryOptions = { autoRefresh: opts.autoRefresh };
    if (opts.symbol) {
      printQuery(await symbolContextQuery(path.resolve(repo), opts.symbol, queryOptions));
      return;
    }
    if (opts.file) {
      printQuery(await fileContextQuery(path.resolve(repo), opts.file, queryOptions));
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
    printQuery(await impactQuery(path.resolve(repo), opts, { autoRefresh: opts.autoRefresh }));
  });

program
  .command("diff-impact")
  .argument("<repo>", "repository root")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Return impact context for the current dirty git diff.")
  .action(async (repo: string, opts: { autoRefresh: boolean }) =>
    printQuery(await diffImpactQuery(path.resolve(repo), { autoRefresh: opts.autoRefresh }))
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
      await testPlanQuery(path.resolve(repo), opts.diff, {
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
        autoRefresh: boolean;
      }
    ) =>
      printQuery(
        await taskBriefQuery(
          path.resolve(repo),
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
          { autoRefresh: opts.autoRefresh }
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
        autoRefresh: boolean;
      }
    ) =>
      printQuery(
        await contextPackQuery(
          path.resolve(repo),
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
          { autoRefresh: opts.autoRefresh }
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
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Classify a broad task, choose likely subsystems, and recommend the next Codexa call.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean; autoRefresh: boolean }) =>
    printQuery(await focusBriefQuery(path.resolve(repo), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("session-context")
  .argument("<repo>", "repository root")
  .option("--task <task>", "optional task to shape startup context")
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2400)
  .option("--limit <n>", "maximum focus items", parseIntOption, 10)
  .option("--diff", "include current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Print the Codexa focus/session packet used when Codex focuses a project.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean; autoRefresh: boolean }) =>
    printQuery(await focusBriefQuery(path.resolve(repo), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, { autoRefresh: opts.autoRefresh }))
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
    printQuery(await callersQuery(path.resolve(repo), opts, { autoRefresh: opts.autoRefresh }))
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
    printQuery(await calleesQuery(path.resolve(repo), opts, { autoRefresh: opts.autoRefresh }))
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
    printQuery(await dependencyPathQuery(path.resolve(repo), opts, { autoRefresh: opts.autoRefresh }))
  );

program
  .command("workflow-path")
  .argument("<repo>", "repository root")
  .option("--query <query>", "natural-language workflow query")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol")
  .option("--limit <n>", "maximum workflow traces", parseIntOption, 8)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Show route/job/manifest workflow traces related to a task, file, or symbol.")
  .action(async (repo: string, opts: { query?: string; file?: string; symbol?: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await workflowPathQuery(path.resolve(repo), opts, { autoRefresh: opts.autoRefresh }))
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
        autoRefresh: boolean;
      }
    ) =>
      printQuery(
        await changePlanQuery(
          path.resolve(repo),
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
            taskId: opts.taskId
          },
          { autoRefresh: opts.autoRefresh }
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
      }
    ) =>
      printQuery(
        await postEditReviewQuery(
          path.resolve(repo),
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
          { autoRefresh: opts.autoRefresh }
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
  .description("Run a structured Codexa quality benchmark with randomized anti-cheat holdouts.")
  .action(async (repo: string, opts: { suite: "all" | "project" | "synthetic" | "historical-fixture" | "task-pack"; seed?: string; taskPack?: string; json?: boolean; autoRefresh: boolean; failOnRefresh: boolean }) => {
    const result = await runEval(
      path.resolve(repo),
      { autoRefresh: opts.autoRefresh },
      { suite: opts.suite, seed: opts.seed, json: opts.json, failOnRefresh: opts.failOnRefresh, taskPackPath: opts.taskPack ? path.resolve(opts.taskPack) : undefined }
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
    console.log(await sessionStartSummary(repo, opts.context || process.env.CODEXA_SESSIONSTART_CONTEXT === "1", opts.autoRefresh));
  });

program
  .command("serve")
  .argument("<repo>", "repository root")
  .option("--auto-refresh", "refresh a stale or missing index before answering MCP context tools", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before answering MCP context tools")
  .description("Start the stdio MCP server.")
  .action(async (repo: string, opts: { autoRefresh: boolean }) => {
    await serveMcp(path.resolve(repo), { autoRefresh: opts.autoRefresh });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function printQuery(result: { text: string }) {
  console.log(result.text);
}

function invokedCliName(): string {
  const basename = path.basename(process.argv[1] ?? "codexa").replace(/\.[cm]?[jt]sx?$/u, "");
  return basename && basename !== "cli" ? basename : "codexa";
}

function compactHookOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  const keep: string[] = [];
  let keepNextActions = false;
  let nextActionCount = 0;
  for (const line of lines) {
    if (
      line.startsWith("Codexa post-edit review") ||
      line.startsWith("Task:") ||
      line.startsWith("Snapshot:") ||
      line.startsWith("Verdict:") ||
      line.startsWith("Outcome record:") ||
      line.startsWith("Tests still unaccounted for:")
    ) {
      keep.push(line);
      continue;
    }
    if (line === "Next actions:") {
      keep.push(line);
      keepNextActions = true;
      nextActionCount = 0;
      continue;
    }
    if (keepNextActions && line.startsWith("- ")) {
      keep.push(line);
      nextActionCount += 1;
      if (nextActionCount >= 4) {
        keepNextActions = false;
      }
      continue;
    }
    if (line.trim() === "") {
      keepNextActions = false;
    }
  }
  return keep.length > 0 ? keep.join("\n") : lines.slice(0, 16).join("\n");
}

async function runAdvisoryHook(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.log(`Codexa: ${label} unavailable: ${hookErrorMessage(error)}`);
    console.log("Codexa: hook is advisory; continuing without blocking the edit.");
  }
}

function hookErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim() || "unknown error";
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseChangeType(value: string): ChangeType {
  const allowed = new Set<ChangeType>(["style", "api", "behavior", "rename", "delete", "unknown"]);
  if (allowed.has(value as ChangeType)) {
    return value as ChangeType;
  }
  throw new Error(`Invalid change type: ${value}`);
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
    if (parsed.exitCode === undefined || !Number.isInteger(parsed.exitCode) || parsed.exitCode < 0) {
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
