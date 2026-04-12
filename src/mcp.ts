import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  contextPackQuery,
  callersQuery,
  calleesQuery,
  changePlanQuery,
  dependencyPathQuery,
  diffImpactQuery,
  findContextQuery,
  focusBriefQuery,
  impactQuery,
  postEditReviewQuery,
  repoMapQuery,
  searchQuery,
  statusQuery,
  symbolContextQuery,
  taskBriefQuery,
  testPlanQuery,
  workflowPathQuery
} from "./queries.js";
import type { FreshnessInfo, QueryOptions, QueryResult } from "./types.js";
import { createQuerySession, type QuerySession } from "./query/session.js";

export async function serveMcp(repoRoot: string, options: QueryOptions = { autoRefresh: true }): Promise<void> {
  const queryOptions = { autoRefresh: options.autoRefresh ?? true };
  const server = new McpServer({
    name: "codexa",
    version: "0.1.0"
  });
  const outputSchema = {
    data: z.unknown(),
    freshness: z.unknown(),
    refresh: z.unknown()
  };
  const sourceContextAnnotations = {
    readOnlyHint: !queryOptions.autoRefresh,
    destructiveHint: false,
    idempotentHint: !queryOptions.autoRefresh,
    openWorldHint: false
  };
  const pureReadAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
  const cacheWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  };
  const changeTypeSchema = z.enum(["style", "api", "behavior", "rename", "delete", "unknown"]);
  const runTool = async (producer: (session: QuerySession) => Promise<QueryResult>) =>
    toToolResult(
      await safeQuery(async () => {
        const session = await createQuerySession(repoRoot, queryOptions);
        return producer(session);
      }, repoRoot)
    );

  server.registerTool(
    "freshness",
    {
      title: "Codexa freshness",
      description: "Report whether the Codexa index is present, fresh, stale, or missing.",
      inputSchema: {},
      outputSchema,
      annotations: pureReadAnnotations
    },
    async () => toToolResult(await safeQuery(() => statusQuery(repoRoot), repoRoot))
  );

  server.registerTool(
    "repo_map",
    {
      title: "Codexa repo map",
      description: "Return the top-ranked modules and files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { limit: z.number().int().positive().max(50).optional(), tokenBudget: z.number().int().min(400).max(8000).optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ limit, tokenBudget }) => runTool((session) => repoMapQuery(session, limit ?? 20, queryOptions, tokenBudget ?? 1500))
  );

  server.registerTool(
    "find_context",
    {
      title: "Codexa find context",
      description: "Find matching files, symbols, and usage sites, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(30).optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ query, limit }) => runTool((session) => findContextQuery(session, query, limit ?? 12, queryOptions))
  );

  server.registerTool(
    "search",
    {
      title: "Codexa search comparison",
      description: "Compare raw string search with Codexa-ranked files, symbols, likely tests, and value/gap labels.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(50).optional(), includeRaw: z.boolean().optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ query, limit, includeRaw }) => runTool((session) => searchQuery(session, { query, limit: limit ?? 12, includeRaw: includeRaw ?? true }, queryOptions))
  );

  server.registerTool(
    "symbol_context",
    {
      title: "Codexa symbol context",
      description: "Return compact context and usage sites for a symbol id or name, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { symbol: z.string().min(1) },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ symbol }) => runTool((session) => symbolContextQuery(session, symbol, queryOptions))
  );

  server.registerTool(
    "impact",
    {
      title: "Codexa impact",
      description: "Return blast-radius evidence for a file or symbol, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: {
        file: z.string().optional(),
        symbol: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        depth: z.number().int().min(1).max(3).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ file, symbol, changeType, depth }) => runTool((session) => impactQuery(session, { file, symbol, changeType, depth }, queryOptions))
  );

  server.registerTool(
    "diff_impact",
    {
      title: "Codexa diff impact",
      description: "Return high-level impact context for the current dirty git diff, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: {},
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async () => runTool((session) => diffImpactQuery(session, queryOptions))
  );

  server.registerTool(
    "test_plan",
    {
      title: "Codexa test plan",
      description: "Recommend targeted tests for the current diff or top-ranked files, refreshing stale Codexa artifacts first when auto-refresh is enabled.",
      inputSchema: { diff: z.boolean().optional() },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async ({ diff }) => runTool((session) => testPlanQuery(session, diff ?? true, queryOptions))
  );

  server.registerTool(
    "task_brief",
    {
      title: "Codexa task brief",
      description:
        "Default first Codexa call before editing, debugging, or reviewing code. Returns a bounded task packet with read-first files, impact expansion, risks, likely tests, freshness, confidence labels, and snippets.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => taskBriefQuery(session, input, queryOptions))
  );

  server.registerTool(
    "context_pack",
    {
      title: "Codexa context pack",
      description: "Build one compact task-shaped context packet with focus files, bounded impact expansion, evidence snippets, impact groups, tests, freshness, and provenance.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => contextPackQuery(session, input, queryOptions))
  );

  server.registerTool(
    "focus_brief",
    {
      title: "Codexa focus brief",
      description: "Use for broad natural-language tasks or session startup. Classifies the task, picks likely subsystems, and recommends the next Codexa tool call.",
      inputSchema: {
        task: z.string().optional(),
        tokenBudget: z.number().int().min(600).max(8000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        diff: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => focusBriefQuery(session, input, queryOptions))
  );

  server.registerTool(
    "session_context",
    {
      title: "Codexa session context",
      description: "Alias for focus_brief tuned for startup/focus events. Returns project focus, dirty groups, likely workflows, and next Codexa call.",
      inputSchema: {
        task: z.string().optional(),
        tokenBudget: z.number().int().min(600).max(8000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        diff: z.boolean().optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => focusBriefQuery(session, input, queryOptions))
  );

  const graphTargetSchema = {
    file: z.string().optional(),
    symbol: z.string().optional(),
    limit: z.number().int().positive().max(80).optional()
  };

  server.registerTool(
    "callers",
    {
      title: "Codexa callers",
      description: "Return typed graph evidence for files/symbols that call, reference, import, or test the target.",
      inputSchema: graphTargetSchema,
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => callersQuery(session, input, queryOptions))
  );

  server.registerTool(
    "callees",
    {
      title: "Codexa callees",
      description: "Return typed graph evidence for symbols/files the target calls, references, imports, tests, or risks.",
      inputSchema: graphTargetSchema,
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => calleesQuery(session, input, queryOptions))
  );

  server.registerTool(
    "dependency_path",
    {
      title: "Codexa dependency path",
      description: "Find a bounded typed graph path between two files or symbols.",
      inputSchema: {
        fromFile: z.string().optional(),
        fromSymbol: z.string().optional(),
        toFile: z.string().optional(),
        toSymbol: z.string().optional(),
        maxDepth: z.number().int().min(1).max(10).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => dependencyPathQuery(session, input, queryOptions))
  );

  server.registerTool(
    "workflow_path",
    {
      title: "Codexa workflow path",
      description: "Return route/job/manifest workflow traces related to a natural-language query, file, or symbol.",
      inputSchema: {
        query: z.string().optional(),
        file: z.string().optional(),
        symbol: z.string().optional(),
        limit: z.number().int().positive().max(30).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => workflowPathQuery(session, input, queryOptions))
  );

  server.registerTool(
    "change_plan",
    {
      title: "Codexa change plan",
      description: "Build a concise Codex edit plan from focus brief, context pack, graph/workflow signals, tests, freshness, and known gaps. Set saveSnapshot=true before edits to enable post_edit_review drift checks.",
      inputSchema: {
        task: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        query: z.string().optional(),
        changeType: changeTypeSchema.optional(),
        diff: z.boolean().optional(),
        tokenBudget: z.number().int().min(500).max(12000).optional(),
        limit: z.number().int().positive().max(40).optional(),
        includeSnippets: z.boolean().optional(),
        saveSnapshot: z.boolean().optional(),
        taskId: z.string().optional()
      },
      outputSchema,
      annotations: cacheWriteAnnotations
    },
    async (input) => runTool((session) => changePlanQuery(session, input, queryOptions))
  );

  server.registerTool(
    "post_edit_review",
    {
      title: "Codexa post-edit review",
      description:
        "After editing, compare the dirty tree against the latest or requested change_plan snapshot. Reports changed files grouped by module, planned-vs-actual drift, symbol/risk deltas, affected callers/tests/workflows, and targeted tests still unaccounted for.",
      inputSchema: {
        task: z.string().optional(),
        taskId: z.string().optional(),
        files: z.array(z.string()).max(20).optional(),
        symbols: z.array(z.string()).max(20).optional(),
        changeType: changeTypeSchema.optional(),
        tokenBudget: z.number().int().min(600).max(10000).optional(),
        limit: z.number().int().positive().max(30).optional(),
        includeSnippets: z.boolean().optional(),
        ranTests: z.array(z.string()).max(30).optional()
      },
      outputSchema,
      annotations: sourceContextAnnotations
    },
    async (input) => runTool((session) => postEditReviewQuery(session, input, queryOptions))
  );

  await registerArtifactResources(server, repoRoot);
  registerWorkflowPrompts(server);

  await server.connect(new StdioServerTransport());
  console.error(`codexa MCP server ready for ${repoRoot} (autoRefresh=${queryOptions.autoRefresh})`);
}

function toToolResult(result: { text: string; data: unknown; freshness: unknown; refresh?: unknown }) {
  return {
    content: [
      {
        type: "text" as const,
        text: result.text
      }
    ],
    structuredContent: {
      data: result.data,
      freshness: result.freshness,
      refresh: result.refresh ?? { refreshed: false }
    }
  };
}

async function safeQuery(producer: () => Promise<QueryResult>, repoRoot: string): Promise<QueryResult> {
  try {
    return await producer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("Missing Codexa index.")) {
      throw error;
    }
    const freshness: FreshnessInfo = {
      schemaVersion: 1,
      snapshotId: "missing-index",
      repoRoot: path.resolve(repoRoot),
      gitRoot: null,
      headCommit: null,
      indexedAt: "",
      dirtyFiles: [],
      dirtyFileHashes: {},
      indexedDirtyFileHashes: {},
      indexedDirtyFiles: [],
      missing: true,
      parserErrorCount: 0,
      stale: true,
      reason: "missing-index"
    };
    const text = [
      "Codexa index missing.",
      `Repo: ${path.resolve(repoRoot)}`,
      `Run: codexa index ${path.resolve(repoRoot)}`,
      "For startup/focus flows with auto-refresh disabled, enable auto-refresh or index once before relying on Codexa context."
    ].join("\n");
    return {
      freshness,
      refresh: { refreshed: false },
      text,
      data: { missingIndex: true, repoRoot: path.resolve(repoRoot), command: `codexa index ${path.resolve(repoRoot)}` }
    };
  }
}

async function registerArtifactResources(server: McpServer, repoRoot: string): Promise<void> {
  const artifacts = [
    ["codebase-readme", "codexa://repo/codebase/README.md", ".codex/codebase/README.md", "text/markdown", "Codexa artifact overview"],
    ["codex-contract", "codexa://repo/codebase/codex-contract.md", ".codex/codebase/codex-contract.md", "text/markdown", "Codex automatic-use contract"],
    ["repo-map", "codexa://repo/codebase/repo-map.md", ".codex/codebase/repo-map.md", "text/markdown", "Ranked repository map"],
    ["risk-map", "codexa://repo/codebase/risk-map.md", ".codex/codebase/risk-map.md", "text/markdown", "Risk-ranked files and signals"],
    ["test-map", "codexa://repo/codebase/test-map.md", ".codex/codebase/test-map.md", "text/markdown", "Detected test files and test edges"],
    ["conventions", "codexa://repo/codebase/conventions.md", ".codex/codebase/conventions.md", "text/markdown", "Detected project conventions"],
    ["workflows", "codexa://repo/codebase/workflows.md", ".codex/codebase/workflows.md", "text/markdown", "Detected workflow traces"],
    ["playbooks", "codexa://repo/codebase/playbooks/README.md", ".codex/codebase/playbooks/README.md", "text/markdown", "Generated Codexa change playbook index"],
    ["freshness-json", "codexa://repo/codebase/freshness.json", ".codex/codebase/freshness.json", "application/json", "Codexa freshness snapshot"]
  ] as const;

  for (const [name, uri, relativePath, mimeType, description] of artifacts) {
    server.registerResource(
      name,
      uri,
      {
        title: `Codexa ${name}`,
        description,
        mimeType
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType,
            text: await readArtifact(repoRoot, relativePath)
          }
        ]
      })
    );
  }

  server.registerResource(
    "module-index",
    "codexa://repo/codebase/modules",
    {
      title: "Codexa module index",
      description: "List generated Codexa module artifact names.",
      mimeType: "text/markdown"
    },
    async () => {
      const modulesDir = path.join(repoRoot, ".codex/codebase/modules");
      let text = "# Codexa Modules\n\n";
      try {
        const allNames = (await fs.readdir(modulesDir)).filter((name) => name.endsWith(".md")).sort();
        const names = allNames.slice(0, 80);
        text += names.map((name) => `- codexa://repo/codebase/modules/${encodeURIComponent(name)}`).join("\n") || "- none";
        if (allNames.length > names.length) {
          text += `\n- ... ${allNames.length - names.length} more modules omitted from this bounded index`;
        }
      } catch {
        text += "- modules unavailable; run `codexa index <repo>` first";
      }
      return { contents: [{ uri: "codexa://repo/codebase/modules", mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "module-artifact",
    new ResourceTemplate("codexa://repo/codebase/modules/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(repoRoot, ".codex/codebase/modules", "codexa://repo/codebase/modules", "Codexa module", "Generated Codexa module artifact")
      })
    }),
    {
      title: "Codexa module artifact",
      description: "Read a generated Codexa module artifact by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(repoRoot, `.codex/codebase/modules/${name}`)
          }
        ]
      };
    }
  );

  server.registerResource(
    "playbook-artifact",
    new ResourceTemplate("codexa://repo/codebase/playbooks/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(
          repoRoot,
          ".codex/codebase/playbooks",
          "codexa://repo/codebase/playbooks",
          "Codexa playbook",
          "Generated Codexa change playbook",
          (name) => name !== "README.md"
        )
      })
    }),
    {
      title: "Codexa playbook artifact",
      description: "Read a generated Codexa change playbook by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(repoRoot, `.codex/codebase/playbooks/${name}`)
          }
        ]
      };
    }
  );
}

async function readArtifact(repoRoot: string, relativePath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codexa artifact missing: ${relativePath}. Run: codexa index ${repoRoot}. ${message}`);
  }
}

async function listMarkdownArtifacts(
  repoRoot: string,
  relativeDir: string,
  uriPrefix: string,
  titlePrefix: string,
  descriptionPrefix: string,
  include: (name: string) => boolean = () => true
) {
  try {
    const names = (await fs.readdir(path.join(repoRoot, relativeDir))).filter((name) => name.endsWith(".md") && include(name)).sort().slice(0, 80);
    return names.map((name) => ({
      name: `${titlePrefix} ${name}`,
      uri: `${uriPrefix}/${encodeURIComponent(name)}`,
      title: `${titlePrefix} ${name}`,
      description: `${descriptionPrefix} ${name}`,
      mimeType: "text/markdown"
    }));
  } catch {
    return [];
  }
}

function artifactNameVariable(value: string | string[]): string {
  const name = Array.isArray(value) ? value.join("/") : value;
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || !name.endsWith(".md")) {
    throw new Error(`Invalid Codexa artifact name: ${name}`);
  }
  return name;
}

function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    "impact_before_edit",
    {
      title: "Codexa impact before edit",
      description: "Use Codexa to gather blast-radius context before changing a file or symbol.",
      argsSchema: {
        target: z.string().describe("File path, symbol name, or symbol id to inspect before editing."),
        task: z.string().optional().describe("Short task description.")
      }
    },
    async ({ target, task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Use Codexa before editing ${target}.`,
              task ? `Task: ${task}` : undefined,
              "Call `change_plan` with `saveSnapshot: true` for the target and task before editing.",
              "Call `impact` only if the plan reports medium/low quality, broad fanout, or a high-risk public contract.",
              "After editing, call `post_edit_review` with the returned task snapshot id.",
              "Read the returned freshness, confidence labels, known gaps, affected files, and likely tests before modifying code."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "dirty_diff_review",
    {
      title: "Codexa dirty diff review",
      description: "Review the current dirty tree with grouped impact and targeted verification.",
      argsSchema: {
        task: z.string().optional().describe("What the dirty diff is supposed to accomplish.")
      }
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa to review the current dirty diff.",
              task ? `Expected intent: ${task}` : undefined,
              "Call `post_edit_review` first if a change_plan snapshot exists; otherwise call `task_brief` with `diff: true`.",
              "Then call `diff_impact` or `test_plan` only if the review or brief leaves a gap.",
              "Check changed-but-unindexed files, parser errors, heuristic-only links, and candidate test command provenance."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "snapshot_edit_loop",
    {
      title: "Codexa snapshot edit loop",
      description: "Use a plan-time snapshot before editing and a drift review after editing.",
      argsSchema: {
        task: z.string().describe("Short description of the intended edit."),
        target: z.string().optional().describe("Optional file path, symbol name, or symbol id to change.")
      }
    },
    async ({ task, target }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa's snapshot edit loop.",
              `Task: ${task}`,
              target ? `Target: ${target}` : undefined,
              "Before editing, call `change_plan` with `saveSnapshot: true` and a short `taskId`.",
              "Use the returned planned files, tests, workflows, quality, and gaps to guide source reads.",
              "After editing, call `post_edit_review` with that `taskId` and any tests already run.",
              "If the review says `inspect` or `replan`, resolve that drift before claiming the edit is complete."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "targeted_test_plan",
    {
      title: "Codexa targeted test plan",
      description: "Generate a focused test plan with command provenance for current changes.",
      argsSchema: {
        task: z.string().optional().describe("Short description of the change being verified.")
      }
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa to create a targeted test plan.",
              task ? `Change under test: ${task}` : undefined,
              "Call `test_plan` with `diff: true` and prefer tests whose commands have package or Python metadata provenance.",
              "If command provenance is missing, inspect the repo scripts before running a command."
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n")
          }
        }
      ]
    })
  );
}
