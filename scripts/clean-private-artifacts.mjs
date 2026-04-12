#!/usr/bin/env node
import { rmSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const targets = [
  ".codex/codebase",
  ".codex/cache",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/.codebase.tmp",
  ".codex/.codebase.backup",
  ".codex/.codexa-index.lock"
];

for (const target of targets) {
  rmSync(path.join(repoRoot, target), { force: true, recursive: true });
}

console.log("Removed local Codexa generated artifacts and repo-local Codex config/cache files.");
