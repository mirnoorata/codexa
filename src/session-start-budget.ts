import { AsyncLocalStorage } from "node:async_hooks";
import { createCommandBudget, withCommandBudget } from "./command.js";

const DEFAULT_BUDGET_MS = 15_000;
const MIN_BUDGET_MS = 1_000;
const MAX_BUDGET_MS = 45_000;
const COMMAND_EXIT_MARGIN_MS = 2_500;

export interface SessionStartBudget {
  readonly totalMs: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  checkpoint(stage: string): void;
}

export class SessionStartBudgetExhausted extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`session-start-total-budget-exhausted:${stage}`);
    this.name = "SessionStartBudgetExhausted";
    this.stage = stage;
  }
}

const sessionStartBudgetContext = new AsyncLocalStorage<SessionStartBudget>();

export async function runWithSessionStartBudget<T>(input: {
  allowWallClockTimeout: boolean;
  operation: (budget: SessionStartBudget) => Promise<T>;
  onTimeout: (totalBudgetMs: number, stage: string) => T;
}): Promise<T> {
  const totalBudgetMs = configuredBudgetMs();
  const startedAt = Date.now();
  const deadlineAt = input.allowWallClockTimeout
    ? startedAt + totalBudgetMs
    : Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  const budget: SessionStartBudget = {
    totalMs: totalBudgetMs,
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => input.allowWallClockTimeout
      ? Math.max(0, deadlineAt - Date.now())
      : Number.POSITIVE_INFINITY,
    checkpoint: (stage: string) => {
      if (
        input.allowWallClockTimeout &&
        (controller.signal.aborted || Date.now() >= deadlineAt)
      ) {
        throw new SessionStartBudgetExhausted(stage);
      }
    }
  };
  const exitMarginMs = Math.min(
    COMMAND_EXIT_MARGIN_MS,
    Math.max(100, Math.floor(totalBudgetMs / 4))
  );
  const commandDeadlineAt = input.allowWallClockTimeout
    ? deadlineAt - exitMarginMs
    : undefined;
  const commandBudget = createCommandBudget(Math.max(
    1,
    totalBudgetMs - exitMarginMs
  ), [], [], commandDeadlineAt);
  const timer = input.allowWallClockTimeout
    ? setTimeout(() => controller.abort(), totalBudgetMs)
    : undefined;
  try {
    return await sessionStartBudgetContext.run(
      budget,
      () => withCommandBudget(commandBudget, async () => {
        try {
          const result = await input.operation(budget);
          budget.checkpoint("complete");
          return result;
        } catch (error) {
          if (error instanceof SessionStartBudgetExhausted) {
            return input.onTimeout(totalBudgetMs, error.stage);
          }
          if (controller.signal.aborted) {
            return input.onTimeout(totalBudgetMs, "operation");
          }
          throw error;
        }
      })
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function sessionStartDeadlineAt(requestedDeadlineAt: number): number {
  const active = sessionStartBudgetContext.getStore();
  return active
    ? Math.min(requestedDeadlineAt, active.deadlineAt)
    : requestedDeadlineAt;
}

function configuredBudgetMs(): number {
  const configured = Number(process.env.CODEXA_SESSION_START_BUDGET_MS);
  if (!Number.isFinite(configured)) return DEFAULT_BUDGET_MS;
  return Math.min(
    MAX_BUDGET_MS,
    Math.max(MIN_BUDGET_MS, Math.trunc(configured))
  );
}
