import { createCommandBudget, withCommandBudget } from "./command.js";

const DEFAULT_BUDGET_MS = 15_000;
const MIN_BUDGET_MS = 1_000;
const MAX_BUDGET_MS = 45_000;
const COMMAND_EXIT_MARGIN_MS = 2_500;

export async function runWithSessionStartBudget<T>(input: {
  allowWallClockTimeout: boolean;
  operation: () => Promise<T>;
  onTimeout: (totalBudgetMs: number) => T;
}): Promise<T> {
  const totalBudgetMs = configuredBudgetMs();
  const commandBudget = createCommandBudget(Math.max(
    1,
    totalBudgetMs - COMMAND_EXIT_MARGIN_MS
  ));
  return withCommandBudget(commandBudget, async () => {
    const operation = input.operation();
    if (!input.allowWallClockTimeout) return operation;
    let timer: NodeJS.Timeout | undefined;
    const exhausted = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(input.onTimeout(totalBudgetMs)), totalBudgetMs);
    });
    try {
      return await Promise.race([operation, exhausted]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

function configuredBudgetMs(): number {
  const configured = Number(process.env.CODEXA_SESSION_START_BUDGET_MS);
  if (!Number.isFinite(configured)) return DEFAULT_BUDGET_MS;
  return Math.min(
    MAX_BUDGET_MS,
    Math.max(MIN_BUDGET_MS, Math.trunc(configured))
  );
}
