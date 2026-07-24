import type { CommandResult } from "./command.js";

export function dependencyCheckFailure(
  result: CommandResult,
  dependencyReason: string
): string {
  if (result.timedOut) return "dependency-completeness-check-timeout";
  if (result.truncated) return "dependency-completeness-diagnostics-limit";
  if (result.error || result.signal || result.exitCode === null) {
    return "dependency-completeness-check-unavailable";
  }
  return dependencyReason;
}
