#!/usr/bin/env node
import { readFileSync } from "node:fs";

const failures = [];

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts ?? {};

requireScriptContains("release:github:dry-run", ["github-release . --dry-run"]);
requireScriptContains("release:github", ["security:check", "github-release ."]);
requireScriptContains("security:check", ["check", "audit", "public:snapshot-check", "package:hygiene"]);
requireScriptContains("lint", ["verify-codexa-publish.sh"]);

requireText("AGENTS.md", [
  "## GitHub Change and Release Path",
  "push that branch to GitHub",
  "npm run release:github",
  "gh release view"
]);
requireText("README.md", [
  "## GitHub Release Timeline",
  "visible source timeline for the current project",
  "npm run release:github",
  "changelog-style summary",
  "changed-area summary",
  "forward-only PR rollback commands"
]);
requireText("docs/PUBLIC_RELEASE_CHECKLIST.md", [
  "npm run release:github",
  "GitHub Release timeline entry",
  "changelog-style summary",
  "changed-area summary",
  "forward-only rollback branch"
]);
requireText("scripts/codexa-publish.sh", [
  "npm run release:github",
  "commit_current_source_if_dirty",
  "select_auto_publish_pr",
  "pr_auto_publish_blocker",
  "merge conflicts with main",
  "no checks reported for PR #",
  "--commit-message",
  "--no-source-commit",
  "verify_github_restore_point",
  "gh release view",
  "git -C \"$ROOT\" ls-remote --exit-code --tags origin"
]);
requireText("scripts/verify-codexa-publish.sh", [
  "skipping PR #16 for auto-publish",
  "PR #16 cannot be published",
  "no open auto-publishable non-bot codex/* PR found"
]);
requireText("src/cli.ts", [".command(\"github-release\")", "--project-name <name>"]);
requireText("src/github-release.ts", [
  "publishProjectGithubRelease",
  "writeProjectReleaseNotes",
  "defaultProjectName",
  "## Changelog",
  "## Changed Areas",
  "## Restore From GitHub"
]);
forbidText("src/github-release.ts", ["codexa-from-", "/path/to/codexa-", "Revert Codexa", "Codexa release timeline entry", `/${"srv"}/`]);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`release-path: ${failure}`);
  }
  process.exit(1);
}

console.log("release-path: GitHub release path verified");

function requireScriptContains(name, expectedParts) {
  const value = scripts[name];
  if (typeof value !== "string") {
    failures.push(`package.json scripts.${name} is missing`);
    return;
  }
  for (const part of expectedParts) {
    if (!value.includes(part)) {
      failures.push(`package.json scripts.${name} must include ${JSON.stringify(part)}`);
    }
  }
}

function requireText(file, expectedParts) {
  const text = read(file);
  for (const part of expectedParts) {
    if (!text.includes(part)) {
      failures.push(`${file} must include ${JSON.stringify(part)}`);
    }
  }
}

function forbidText(file, forbiddenParts) {
  const text = read(file);
  for (const part of forbiddenParts) {
    if (text.includes(part)) {
      failures.push(`${file} must not include ${JSON.stringify(part)}`);
    }
  }
}

function read(file) {
  return readFileSync(file, "utf8");
}
