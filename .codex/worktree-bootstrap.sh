#!/usr/bin/env bash
set -euo pipefail
umask 077

git_top="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'Codexa bootstrap must run inside a Git worktree.\n' >&2
  exit 2
}
repo_root="$(cd "$git_top" && pwd -P)"
cd "$repo_root"

for command_name in git node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Codexa bootstrap requires %s on PATH.\n' "$command_name" >&2
    exit 2
  fi
done

node -e '
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    console.error(`Codexa requires Node.js 22 or newer; found ${process.version}.`);
    process.exit(2);
  }
'

if [[ ! -f package.json || ! -f package-lock.json ]]; then
  printf 'Codexa bootstrap requires package.json and package-lock.json at %s.\n' "$repo_root" >&2
  exit 2
fi

if [[ -L .codex || -L .codex/tmp ]]; then
  printf 'Codexa bootstrap refuses symlinked .codex state paths.\n' >&2
  exit 2
fi
mkdir -p .codex/tmp
chmod 700 .codex/tmp
bootstrap_log="$repo_root/.codex/tmp/worktree-bootstrap.log"
bootstrap_receipt="$repo_root/.codex/tmp/worktree-bootstrap-receipt.json"
bootstrap_lock_dir="$repo_root/.codex/tmp/worktree-bootstrap.lock"
receipt_tmp=""

release_bootstrap_lock() {
  [[ -z "$receipt_tmp" ]] || rm -f "$receipt_tmp"
  rm -f "$bootstrap_lock_dir/pid"
  rmdir "$bootstrap_lock_dir" 2>/dev/null || true
}

acquire_bootstrap_lock() {
  if mkdir "$bootstrap_lock_dir" 2>/dev/null; then
    chmod 700 "$bootstrap_lock_dir"
  else
    if [[ -L "$bootstrap_lock_dir" || ! -d "$bootstrap_lock_dir" ]]; then
      printf 'Codexa bootstrap lock is not a safe directory: %s\n' "$bootstrap_lock_dir" >&2
      return 75
    fi
    local owner_pid=""
    if [[ -f "$bootstrap_lock_dir/pid" && ! -L "$bootstrap_lock_dir/pid" ]]; then
      IFS= read -r owner_pid <"$bootstrap_lock_dir/pid" || true
    fi
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      printf 'Codexa bootstrap is already running for %s (pid %s).\n' "$repo_root" "$owner_pid" >&2
      return 75
    fi
    if [[ ! "$owner_pid" =~ ^[0-9]+$ ]]; then
      printf 'Codexa bootstrap lock has no valid owner; inspect: %s\n' "$bootstrap_lock_dir" >&2
      return 75
    fi
    rm -f "$bootstrap_lock_dir/pid"
    if ! rmdir "$bootstrap_lock_dir" 2>/dev/null || ! mkdir "$bootstrap_lock_dir" 2>/dev/null; then
      printf 'Codexa bootstrap found a stale non-empty lock; inspect: %s\n' "$bootstrap_lock_dir" >&2
      return 75
    fi
    chmod 700 "$bootstrap_lock_dir"
  fi
  printf '%s\n' "$$" >"$bootstrap_lock_dir/pid"
  chmod 600 "$bootstrap_lock_dir/pid"
}

acquire_bootstrap_lock
trap release_bootstrap_lock EXIT
# Remove generated path entries before opening them so a stale symlink or
# hardlink cannot redirect writes. A failed rerun leaves no readiness receipt.
rm -f "$bootstrap_log" "$bootstrap_receipt"
: >"$bootstrap_log"
chmod 600 "$bootstrap_log"

run_logged() {
  local label="$1"
  shift
  printf '== %s ==\n' "$label" >>"$bootstrap_log"
  if ! "$@" >>"$bootstrap_log" 2>&1; then
    printf 'Codexa bootstrap failed during %s; log: %s\n' "$label" "$bootstrap_log" >&2
    return 1
  fi
}

lock_digest="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"));
')"
root_lock_digest="$(node -e '
  const { createHash } = require("node:crypto");
  const { existsSync, readFileSync } = require("node:fs");
  const digest = (file) => existsSync(file)
    ? createHash("sha256").update(readFileSync(file)).digest("hex")
    : "missing";
  const manifest = ["package-lock.json", "uv.lock"]
    .map((file) => `${file}\t${digest(file)}\n`)
    .join("");
  process.stdout.write(createHash("sha256").update(manifest, "utf8").digest("hex"));
')"
dependency_key="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const hash = createHash("sha256");
  hash.update(readFileSync("package.json"));
  hash.update("\0");
  hash.update(readFileSync("package-lock.json"));
  hash.update(`\0${process.versions.modules}\0${process.platform}\0${process.arch}`);
  process.stdout.write(hash.digest("hex"));
')"
dependency_marker="node_modules/.codexa-dependencies.sha256"

if [[ -x node_modules/.bin/tsc && -f "$dependency_marker" ]] &&
  [[ "$(<"$dependency_marker")" == "$dependency_key" ]]; then
  dependency_state="current"
else
  run_logged "npm ci" npm ci --no-audit --no-fund
  printf '%s\n' "$dependency_key" >"$dependency_marker"
  dependency_state="installed"
fi

build_input_digest="$(CODEXA_BOOTSTRAP_DEPENDENCY_KEY="$dependency_key" node -e '
  const { createHash } = require("node:crypto");
  const { readdirSync, readFileSync } = require("node:fs");
  const { join, relative } = require("node:path");
  const files = ["package.json", "package-lock.json", "tsconfig.json"];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Codexa source contains a non-regular entry: ${path}`);
    }
  };
  visit("src");
  const hash = createHash("sha256");
  hash.update(process.env.CODEXA_BOOTSTRAP_DEPENDENCY_KEY ?? "");
  for (const file of files.sort()) {
    hash.update(`\0${relative(".", file)}\0`);
    hash.update(readFileSync(file));
  }
  process.stdout.write(hash.digest("hex"));
')"

run_logged "build" npm run build
run_logged "Codexa core init" node dist/cli.js init "$repo_root" --tools core
run_logged "Codexa strict startup check" node dist/cli.js session-start "$repo_root" --json --strict

git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
git_common_dir="$(node -e '
  const { realpathSync } = require("node:fs");
  process.stdout.write(realpathSync(process.argv[1]));
' "$git_common_dir")"
head_commit="$(git rev-parse HEAD)"
receipt_tmp="$(mktemp "$repo_root/.codex/tmp/worktree-bootstrap-receipt.XXXXXX")"
CODEXA_BOOTSTRAP_REPO_ROOT="$repo_root" \
CODEXA_BOOTSTRAP_COMMON_DIR="$git_common_dir" \
CODEXA_BOOTSTRAP_HEAD="$head_commit" \
CODEXA_BOOTSTRAP_LOCK_DIGEST="$lock_digest" \
CODEXA_BOOTSTRAP_ROOT_LOCK_DIGEST="$root_lock_digest" \
CODEXA_BOOTSTRAP_DEPENDENCY_KEY="$dependency_key" \
CODEXA_BOOTSTRAP_DEPENDENCY_STATE="$dependency_state" \
CODEXA_BOOTSTRAP_BUILD_DIGEST="$build_input_digest" \
  node -e '
    const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { join, relative } = require("node:path");
    const [output] = process.argv.slice(1);
    const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const treeSha256 = (directory) => {
      const files = [];
      const visit = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const file = join(current, entry.name);
          if (entry.isDirectory()) visit(file);
          else if (entry.isFile()) files.push(file);
          else throw new Error(`Codexa runtime contains a non-regular entry: ${file}`);
        }
      };
      visit(directory);
      const hash = createHash("sha256");
      for (const file of files.sort()) {
        hash.update(`\0${relative(directory, file)}\0`);
        hash.update(readFileSync(file));
      }
      return hash.digest("hex");
    };
    const receipt = {
      schemaVersion: 1,
      kind: "codexa-worktree-bootstrap",
      status: "setup-complete",
      repoRoot: process.env.CODEXA_BOOTSTRAP_REPO_ROOT,
      gitCommonDir: process.env.CODEXA_BOOTSTRAP_COMMON_DIR,
      head: process.env.CODEXA_BOOTSTRAP_HEAD,
      rootLockSha256: process.env.CODEXA_BOOTSTRAP_ROOT_LOCK_DIGEST,
      packageLockSha256: process.env.CODEXA_BOOTSTRAP_LOCK_DIGEST,
      dependencyKey: process.env.CODEXA_BOOTSTRAP_DEPENDENCY_KEY,
      dependencyState: process.env.CODEXA_BOOTSTRAP_DEPENDENCY_STATE,
      buildInputSha256: process.env.CODEXA_BOOTSTRAP_BUILD_DIGEST,
      distCliSha256: sha256("dist/cli.js"),
      distRuntimeSha256: treeSha256("dist"),
      configSha256: sha256(".codex/config.toml"),
      toolProfile: "core",
      readiness: {
        dependencies: "ready",
        build: "ready",
        codexaConfig: "configured",
        codexaStrict: "passed",
        threadMcp: "unverified",
      },
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  ' "$receipt_tmp"
chmod 600 "$receipt_tmp"
mv "$receipt_tmp" "$bootstrap_receipt"
receipt_tmp=""

printf 'Codexa bootstrap: dependencies=%s; build=ready; wiring=core; receipt=%s; log=%s\n' \
  "$dependency_state" "$bootstrap_receipt" "$bootstrap_log"
