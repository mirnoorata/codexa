import { createCommandBudget, withCommandBudget } from "./command.js";
import { sessionStartDeadlineAt } from "./session-start-budget.js";
import { ADOPTION_SCAN_TIMEOUT_MS } from "./worktree-bootstrap-adoption.js";
import type { WorktreeBootstrapValidation } from "./worktree-bootstrap-receipt.js";

// A timed-out direct Git subprocess can need the command runner's 2 s
// termination grace plus terminal pipe settlement. Reserve that inside the
// public 20 s adoption wall so the shared 30 s controller retains headroom for
// process startup, JSON serialization, and its own termination.
const ADOPTION_COMMAND_SETTLEMENT_RESERVE_MS = 2_500;

export function adoptionValidationDeadlineAt(
  validation: WorktreeBootstrapValidation,
  requestedDeadlineAt?: number
): number | undefined {
  if (validation !== "adoption") return undefined;
  const defaultDeadlineAt =
    Date.now() + ADOPTION_SCAN_TIMEOUT_MS - ADOPTION_COMMAND_SETTLEMENT_RESERVE_MS;
  const requested = Number.isFinite(requestedDeadlineAt)
    ? Math.trunc(requestedDeadlineAt as number)
    : Number.POSITIVE_INFINITY;
  return sessionStartDeadlineAt(Math.min(defaultDeadlineAt, requested));
}

export function withAdoptionCommandBudget<T>(
  deadlineAt: number,
  operation: () => Promise<T>
): Promise<T> {
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  const budget = createCommandBudget(remainingMs, [], [], deadlineAt);
  return withCommandBudget(budget, operation);
}

export function adoptionDeadlineExpired(deadlineAt?: number): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}
