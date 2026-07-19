import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// enabledTools mirrors the server's registration filter: prompt text must
// not instruct the model to call a tool the reduced profile never registered.
export function registerWorkflowPrompts(server: McpServer, enabledTools?: ReadonlySet<string>): void {
  const toolAvailable = (name: string): boolean => !enabledTools || enabledTools.has(name);
  const call = (name: string, purpose: string): string =>
    toolAvailable(name)
      ? `Call \`${name}\` ${purpose}.`
      : `Call \`capabilities\` with \`action: "invoke"\`, \`operation: "${name}"\`, and the operation arguments ${purpose}.`;
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
              `Use one bounded Codexa impact packet before editing ${target}.`,
              task ? `Task: ${task}` : undefined,
              call("impact", "for this exact target"),
              "Do not also call `change_plan` unless the impact packet proves a material cross-boundary risk that needs a saved plan.",
              "After editing, rely on the managed host completion gate; on a hookless host, run one post_edit_review only when drift accountability is still needed.",
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
              call("post_edit_review", "once for the current dirty diff and saved task id when one exists"),
              "Inspect the returned source targets directly. Invoke diff_impact or test_plan only if this explicit review leaves a concrete impact or verification gap.",
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
              "If the target is exact, call `change_plan` with `saveSnapshot: true` and a short `taskId`. If it is ambiguous, call `search` once and do not stack another context packet unless the scope becomes materially risky.",
              "Use the returned planned files, tests, workflows, quality, and gaps to guide source reads.",
              "After editing, rely on the managed host completion gate. Only on a hookless host, call post_edit_review once with that taskId and tests already run.",
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
              call("test_plan", "with diff=true and the explicit target when known"),
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
