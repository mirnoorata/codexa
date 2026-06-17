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
fixture_count="${CODEXA_EVAL_FIXTURE_FILES:-32}"
mkdir -p "$report_dir"

if ! [[ "$fixture_count" =~ ^[0-9]+$ ]] || [ "$fixture_count" -lt 1 ]; then
  echo "eval gate FAILED: CODEXA_EVAL_FIXTURE_FILES must be a positive integer" >&2
  exit 1
fi

backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/codexa-eval-fixture.XXXXXX")"
eval_fixture_files=()

restore_eval_fixture() {
  local status=$?
  if [ "${#eval_fixture_files[@]}" -gt 0 ]; then
    for file in "${eval_fixture_files[@]}"; do
      cp "$backup_dir/$file" "$file"
    done
  fi
  rm -rf "$backup_dir"
  exit "$status"
}

trap restore_eval_fixture EXIT

mapfile -t eval_fixture_files < <(git ls-files 'src/**/*.ts' 'tests/**/*.ts' | LC_ALL=C sort | head -n "$fixture_count")
if [ "${#eval_fixture_files[@]}" -lt "$fixture_count" ]; then
  echo "eval gate FAILED: only found ${#eval_fixture_files[@]} tracked TypeScript fixture files, need $fixture_count" >&2
  exit 1
fi

for file in "${eval_fixture_files[@]}"; do
  mkdir -p "$backup_dir/$(dirname "$file")"
  cp "$file" "$backup_dir/$file"
  printf '\n// codexa-eval-fixture: reversible dirty-tree seed for retrieval gate\n' >>"$file"
done

seeded_dirty_count="$(git status --short -- "${eval_fixture_files[@]}" | wc -l | tr -d ' ')"
if [ "$seeded_dirty_count" -lt "$fixture_count" ]; then
  echo "eval gate FAILED: seeded dirty fixture produced only $seeded_dirty_count dirty files, need $fixture_count" >&2
  exit 1
fi

# A fresh CI checkout has no .codex/codebase index (gitignored); the project
# suite scores dirty-tree behavior against it, so seed a deterministic tracked
# fixture diff before indexing. The trap restores source files after the run.
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
