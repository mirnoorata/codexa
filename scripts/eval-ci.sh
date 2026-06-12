#!/usr/bin/env bash
# Retrieval-quality gate: `codexa eval` exits non-zero if ANY scenario fails —
# including when the raw rg/git baseline beats Codexa, when output exceeds
# byte budgets, or when packets are heuristic-heavy. The seed varies per
# commit so the synthetic anti-cheat holdouts cannot be overfitted to a
# single fixed layout.
set -euo pipefail

# Location-independent: all paths below are relative to the repo root.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

seed="${CODEXA_EVAL_SEED:-${GITHUB_SHA:-local-$(git rev-parse HEAD 2>/dev/null || echo dev)}}"
report_dir=".codex/cache/codexa-eval"
report="$report_dir/latest.json"
mkdir -p "$report_dir"

# A fresh CI checkout has no .codex/codebase index (gitignored); the project
# suite scores against it, so build it first. ~3s on this repository.
node dist/cli.js index . >/dev/null

if ! node dist/cli.js eval . --suite all --seed "ci-${seed}" --json >"$report"; then
  cat "$report" >&2 || true
  echo "eval gate FAILED: a scenario lost to the raw baseline, exceeded budget, or failed outright (seed ci-${seed})" >&2
  exit 1
fi

node -e '
const report = require("./.codex/cache/codexa-eval/latest.json");
const cal = report.calibrationSummary ?? {};
console.log(`eval gate passed: ${report.scenarios?.length ?? "?"} scenarios, score ${report.score}, rawRgBetter=${(cal.rawRgBetterScenarios ?? []).length}, seed ${report.seed}`);
'
