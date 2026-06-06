import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerWorkflowPrompts(server: McpServer): void {
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
