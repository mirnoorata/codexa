import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// enabledTools mirrors the server's registration filter: prompt text must
// not instruct the model to call a tool the reduced profile never registered.
export function registerWorkflowPrompts(server: McpServer, enabledTools?: ReadonlySet<string>): void {
  const toolAvailable = (name: string): boolean => !enabledTools || enabledTools.has(name);
  const call = (name: string, purpose: string, operationArguments: Record<string, unknown> = {}): string =>
    toolAvailable(name)
      ? `Call \`${name}\` ${purpose}.`
      : `Call \`capabilities\` with \`action: "invoke"\`, \`operation: "${name}"\`, and \`arguments: ${JSON.stringify(operationArguments)}\` ${purpose}.`;
  const impactCall = (target: string, targetKind?: "file" | "symbol"): string => {
    if (targetKind) return call("impact", "for this exact target", { [targetKind]: target });
    if (toolAvailable("impact")) {
      return `Call \`impact\` with \`file: ${JSON.stringify(target)}\` when this is a file path, or \`symbol: ${JSON.stringify(target)}\` when it is a symbol or id.`;
    }
    return `Call \`capabilities\` with \`action: "invoke"\`, \`operation: "impact"\`, and either \`arguments: ${JSON.stringify({ file: target })}\` for a file path or \`arguments: ${JSON.stringify({ symbol: target })}\` for a symbol or id.`;
  };
  server.registerPrompt(
    "impact_before_edit",
    {
      title: "Codexa impact before edit",
      description: "Use Codexa to gather blast-radius context before changing a file or symbol.",
      argsSchema: {
        target: z.string().describe("File path, symbol name, or symbol id to inspect before editing."),
        targetKind: z.enum(["file", "symbol"]).optional().describe("Disambiguates extensionless file paths from symbols."),
        task: z.string().optional().describe("Short task description.")
      }
    },
    async ({ target, targetKind, task }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Use one bounded Codexa impact packet before editing ${target}.`,
              task ? `Task: ${task}` : undefined,
              impactCall(target, targetKind),
              "Do not also call `change_plan` unless the impact packet proves a material cross-boundary risk that needs a saved plan.",
              "After planned verification, rely on a true completion/Stop gate when present. An edit-only hook is not a completion gate; otherwise:",
              call("post_edit_review", "once when final drift accountability is still needed"),
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
        task: z.string().optional().describe("What the dirty diff is supposed to accomplish."),
        taskId: z.string().optional().describe("Saved change-plan task id when more than one snapshot may exist.")
      }
    },
    async ({ task, taskId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use Codexa to review the current dirty diff.",
              task ? `Expected intent: ${task}` : undefined,
              call(
                "post_edit_review",
                taskId ? "once for the current dirty diff and this saved task id" : "only when there is no saved snapshot or the latest snapshot is unambiguous",
                taskId ? { taskId } : {}
              ),
              taskId ? undefined : "If multiple saved snapshots exist, render this prompt again with `taskId` instead of guessing.",
              "Inspect the returned source targets directly.",
              call("diff_impact", "only if this explicit review leaves a concrete impact gap"),
              call("test_plan", "only if this explicit review leaves a concrete verification gap", { diff: true }),
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
              target ? call("change_plan", "with `saveSnapshot: true` and a short `taskId`") : call("search", "once; do not stack another context packet unless the scope becomes materially risky"),
              "Use the returned planned files, tests, workflows, quality, and gaps to guide source reads.",
              "After planned verification, rely on a true completion/Stop gate when present. An edit-only hook is not a completion gate; otherwise:",
              call("post_edit_review", "once with that taskId and tests already run", { taskId: "<saved taskId>" }),
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
              call("test_plan", "with diff=true and the explicit target when known", { diff: true }),
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
