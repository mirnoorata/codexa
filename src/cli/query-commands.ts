import type { Command } from "commander";
import { RAW_SEARCH_EXPLICIT_PATTERN_LIMIT } from "../query/raw-search.js";
import {
  callersQuery,
  calleesQuery,
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
import type { ChangeType, SessionMemoryInput } from "../types.js";
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

export function registerQueryCommands(program: Command): void {
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
  .option("--file <path...>", "target file path; repeat or pass multiple paths")
  .option("--diff", "use current dirty git diff", true)
  .option("--no-diff", "ignore current dirty git diff")
  .option("--change-type <type>", "change type: style, api, behavior, rename, delete, unknown", parseChangeType, "unknown")
  .option("--auto-refresh", "refresh a stale or missing index before querying", true)
  .option("--no-auto-refresh", "do not refresh a stale or missing index before querying")
  .description("Recommend targeted tests.")
  .action(async (repo: string, opts: { file?: string[]; diff: boolean; changeType: ChangeType; autoRefresh: boolean }) =>
    printQuery(
      await testPlanQuery(await resolveQueryRepoRoot(repo), opts.diff, {
        autoRefresh: opts.autoRefresh,
        files: opts.file,
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


}
