import type { Command } from "commander";
import { appendFile } from "node:fs/promises";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "../query/raw-search.js";
import {
  callersQuery,
  calleesQuery,
  changeReviewQuery,
  changePlanQuery,
  contextPackQuery,
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
} from "../queries.js";
import { renderChangeReviewGithubAnnotations, renderChangeReviewMarkdown, type ChangeReviewData, type ChangeReviewMode } from "../query/change-review.js";
import type { ChangeType, SessionMemoryInput } from "../types.js";
import { parseInvariantReviewJsonOptions, validateArtifactIds, validateInvariantStatements } from "../lifecycle-contract.js";
import {
  parseChangeType,
  parseCommandReportOptions,
  parseIntOption,
  parseSemanticProvider,
  parseSessionMemoryAction,
  parseSessionMemoryEntries,
  parseSessionMemoryKinds,
  parseWaiverOptions,
  printQuery,
  queryOptionsFromCli,
  resolveQueryRepoRoot,
  type CliQueryOptions
} from "./options.js";

function addWorkspaceRoutingOptions(command: Command): Command {
  return command
    .option("--workspace-focus-file <path>", "workspace focus file to consult when <repo> is a workspace launch root")
    .option("--workspace-session <id>", "active WORKING.md session row to prefer when <repo> is a workspace launch root");
}

function parseChangeReviewMode(value: string): ChangeReviewMode {
  if (value === "observe" || value === "warn" || value === "fail") return value;
  throw new Error("change review mode must be observe, warn, or fail");
}

function parseChangeReviewFormat(value: string): "text" | "json" | "github" {
  if (value === "text" || value === "json" || value === "github") return value;
  throw new Error("change review format must be text, json, or github");
}

export function registerQueryCommands(program: Command): void {
addWorkspaceRoutingOptions(program
  .command("status")
  .argument("<repo>", "repository root")
  .option("--json", "emit structured JSON"))
  .description("Report Codexa index freshness and parser status.")
  .action(async (repo: string, opts: CliQueryOptions & { json?: boolean }) => {
    const result = await statusQuery(await resolveQueryRepoRoot(repo, opts));
    if (opts.json) {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }
    printQuery(result);
  });

addWorkspaceRoutingOptions(program
  .command("repo-map")
  .argument("<repo>", "repository root")
  .option("--limit <n>", "maximum files/modules to return", parseIntOption, 20)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 1500)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Print the top-ranked repo map, refreshing stale artifacts when needed.")
  .action(async (repo: string, opts: { limit: number; budget: number; autoRefresh: boolean }) =>
    printQuery(await repoMapQuery(await resolveQueryRepoRoot(repo, opts), opts.limit, { autoRefresh: opts.autoRefresh }, opts.budget))
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Find matching files, symbols, and usage sites.")
  .action(async (repo: string, opts: { query: string; limit: number } & CliQueryOptions) =>
    printQuery(await findContextQuery(await resolveQueryRepoRoot(repo, opts), opts.query, opts.limit, queryOptionsFromCli(opts)))
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Run first-class hybrid semantic search over raw hits, Codexa ranking, tests, and known gaps.")
  .action(async (repo: string, opts: { query: string; pattern?: string[]; limit: number; raw: boolean } & CliQueryOptions) =>
    printQuery(
      await searchQuery(
        await resolveQueryRepoRoot(repo, opts),
        { query: opts.query, patterns: opts.pattern, limit: opts.limit, includeRaw: opts.raw },
        queryOptionsFromCli(opts)
      )
    )
  );

addWorkspaceRoutingOptions(program
  .command("placeholder-report")
  .argument("<repo>", "repository root")
  .option("--include-tests", "include test files in placeholder findings", false)
  .option("--include-docs", "include documentation files in placeholder findings", false)
  .option("--include-generated", "include generated files in placeholder findings", false)
  .option("--limit <n>", "maximum findings", parseIntOption, 40)
  .option("--budget <tokens>", "approximate token budget", parseIntOption, 2400)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Report indexed placeholder, dummy, TODO, and stub code/data findings.")
  .action(async (repo: string, opts: { includeTests: boolean; includeDocs: boolean; includeGenerated: boolean; limit: number; budget: number; autoRefresh: boolean }) =>
    printQuery(
      await placeholderReportQuery(
        await resolveQueryRepoRoot(repo, opts),
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

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Return compact evidence for a file or symbol.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; depth?: number; language?: string; evidence?: boolean } & CliQueryOptions) => {
    const queryOptions = queryOptionsFromCli(opts);
    const repoRoot = await resolveQueryRepoRoot(repo, opts);
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

addWorkspaceRoutingOptions(program
  .command("impact")
  .argument("<repo>", "repository root")
  .option("--file <path>", "file to analyze")
  .option("--symbol <symbol>", "symbol id or name to analyze")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--depth <n>", "import/test traversal depth, 1-3; default is adaptive by change type", parseIntOption)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Return blast-radius evidence for a file or symbol.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; changeType: ChangeType; depth?: number; autoRefresh: boolean }) => {
    if (!opts.file && !opts.symbol) {
      throw new Error("impact requires --file or --symbol");
    }
    printQuery(await impactQuery(await resolveQueryRepoRoot(repo, opts), opts, { autoRefresh: opts.autoRefresh }));
  });

addWorkspaceRoutingOptions(program
  .command("diff-impact")
  .argument("<repo>", "repository root")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Return impact context for the current dirty git diff.")
  .action(async (repo: string, opts: { autoRefresh: boolean }) =>
    printQuery(await diffImpactQuery(await resolveQueryRepoRoot(repo, opts), { autoRefresh: opts.autoRefresh }))
  );

addWorkspaceRoutingOptions(program
  .command("review")
  .argument("[repo]", "repository root; defaults to the current directory", process.cwd())
  .requiredOption("--base <ref>", "base Git ref or commit for the review")
  .option("--head <ref>", "head Git ref or commit; must match the indexed checkout", "HEAD")
  .option("--mode <mode>", "policy mode: observe, warn, or fail", parseChangeReviewMode, "observe")
  .option("--format <format>", "output format: text, json, or github", parseChangeReviewFormat, "text")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--task-id <id>", "local Codexa change-plan snapshot to compare against")
  .option("--plan-snapshot <path>", "portable Codexa change-plan snapshot inside the repository")
  .option("--ran-test <test...>", "test file or direct test reference already run; repeat or pass multiple values")
  .option("--ran-command <command...>", "verification command already run; repeat or pass multiple values")
  .option("--ran-command-report <json...>", "structured command report JSON including command and optional exitCode")
  .option("--auto-refresh", "refresh a stale or missing index before reviewing", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before reviewing"))
  .description("Review a committed base-to-head change with one deterministic receipt for humans, agents, and CI.")
  .action(async (repo: string, opts: {
    base: string;
    head: string;
    mode: ChangeReviewMode;
    format: "text" | "json" | "github";
    changeType: ChangeType;
    taskId?: string;
    planSnapshot?: string;
    ranTest?: string[];
    ranCommand?: string[];
    ranCommandReport?: string[];
    autoRefresh: boolean;
  } & CliQueryOptions) => {
    const result = await changeReviewQuery(
      await resolveQueryRepoRoot(repo, opts),
      {
        base: opts.base,
        head: opts.head,
        mode: opts.mode,
        changeType: opts.changeType,
        taskId: opts.taskId,
        planSnapshot: opts.planSnapshot,
        ranTests: opts.ranTest,
        ranCommands: opts.ranCommand,
        ranCommandReports: parseCommandReportOptions(opts.ranCommandReport)
      },
      { autoRefresh: opts.autoRefresh }
    );
    const data = result.data as ChangeReviewData;
    if (opts.format === "json") console.log(JSON.stringify(data, null, 2));
    else if (opts.format === "github") {
      for (const annotation of renderChangeReviewGithubAnnotations(data)) console.log(annotation);
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath) await appendFile(summaryPath, `${renderChangeReviewMarkdown(data)}\n`, "utf8");
      else console.log(renderChangeReviewMarkdown(data));
    } else printQuery(result);
    if (data.verdict.blocking) process.exitCode = 2;
  });

addWorkspaceRoutingOptions(program
  .command("test-plan")
  .argument("<repo>", "repository root")
  .option("--file <path...>", "target file path; repeat or pass multiple paths")
  .option("--diff", "use current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Recommend targeted tests.")
  .action(async (repo: string, opts: { file?: string[]; diff: boolean; changeType: ChangeType; autoRefresh: boolean }) =>
    printQuery(
      await testPlanQuery(await resolveQueryRepoRoot(repo, opts), opts.diff, {
        autoRefresh: opts.autoRefresh,
        files: opts.file,
        changeType: opts.changeType
      })
    )
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
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
          await resolveQueryRepoRoot(repo, opts),
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

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
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
          await resolveQueryRepoRoot(repo, opts),
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

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Classify a broad task, choose likely subsystems, and recommend the next Codexa call.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean } & CliQueryOptions) =>
    printQuery(await focusBriefQuery(await resolveQueryRepoRoot(repo, opts), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, queryOptionsFromCli(opts)))
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Print the Codexa focus/session packet used when Codex focuses a project.")
  .action(async (repo: string, opts: { task?: string; budget: number; limit: number; diff: boolean } & CliQueryOptions) =>
    printQuery(await focusBriefQuery(await resolveQueryRepoRoot(repo, opts), { task: opts.task, tokenBudget: opts.budget, limit: opts.limit, diff: opts.diff }, queryOptionsFromCli(opts)))
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
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
          await resolveQueryRepoRoot(repo, opts),
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

addWorkspaceRoutingOptions(program
  .command("callers")
  .argument("<repo>", "repository root")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol id, qualified name, or unique name")
  .option("--limit <n>", "maximum graph edges", parseIntOption, 20)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Show graph callers, importers, references, and tests for a target.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await callersQuery(await resolveQueryRepoRoot(repo, opts), opts, { autoRefresh: opts.autoRefresh }))
  );

addWorkspaceRoutingOptions(program
  .command("callees")
  .argument("<repo>", "repository root")
  .option("--file <path>", "target file")
  .option("--symbol <symbol>", "target symbol id, qualified name, or unique name")
  .option("--limit <n>", "maximum graph edges", parseIntOption, 20)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Show graph callees, dependencies, imports, and risk surfaces for a target.")
  .action(async (repo: string, opts: { file?: string; symbol?: string; limit: number; autoRefresh: boolean }) =>
    printQuery(await calleesQuery(await resolveQueryRepoRoot(repo, opts), opts, { autoRefresh: opts.autoRefresh }))
  );

addWorkspaceRoutingOptions(program
  .command("dependency-path")
  .argument("<repo>", "repository root")
  .option("--from-file <path>", "source file")
  .option("--from-symbol <symbol>", "source symbol")
  .option("--to-file <path>", "target file")
  .option("--to-symbol <symbol>", "target symbol")
  .option("--max-depth <n>", "maximum graph depth", parseIntOption, 6)
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Find a typed dependency path between files or symbols.")
  .action(async (repo: string, opts: { fromFile?: string; fromSymbol?: string; toFile?: string; toSymbol?: string; maxDepth: number; autoRefresh: boolean }) =>
    printQuery(await dependencyPathQuery(await resolveQueryRepoRoot(repo, opts), opts, { autoRefresh: opts.autoRefresh }))
  );

addWorkspaceRoutingOptions(program
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
  .description("Show route/job/manifest workflow traces related to a task, file, or symbol.")
  .action(async (repo: string, opts: { query?: string; file?: string; symbol?: string; limit: number } & CliQueryOptions) =>
    printQuery(await workflowPathQuery(await resolveQueryRepoRoot(repo, opts), opts, queryOptionsFromCli(opts)))
  );

addWorkspaceRoutingOptions(program
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
  .option("--invariant <statement...>", "task invariant to preserve and explicitly review; repeat or pass multiple values")
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
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
        invariant?: string[];
      } & CliQueryOptions
    ) =>
      printQuery(
        await changePlanQuery(
          await resolveQueryRepoRoot(repo, opts),
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
            followCandidate: opts.followCandidate,
            invariants: validateInvariantStatements(opts.invariant)
          },
          queryOptionsFromCli(opts)
        )
      )
  );

addWorkspaceRoutingOptions(program
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
  .option("--invariant-review <json...>", "task invariant review JSON: {\"invariantId\":\"inv-...\",\"status\":\"satisfied\",\"evidence\":[\"reviewed diff\"]}")
  .option("--artifact-id <id...>", "ingested verification artifact ID to bind to this review")
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
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying"))
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
        invariantReview?: string[];
        artifactId?: string[];
        autoRefresh: boolean;
      } & CliQueryOptions
    ) =>
      printQuery(
        await postEditReviewQuery(
          await resolveQueryRepoRoot(repo, opts),
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
            waivers: parseWaiverOptions(opts.waiver),
            invariantReviews: parseInvariantReviewJsonOptions(opts.invariantReview),
            artifactIds: validateArtifactIds(opts.artifactId)
          },
          queryOptionsFromCli(opts)
        )
      )
  );
}
