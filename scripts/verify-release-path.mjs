#!/usr/bin/env node
import { readFileSync } from "node:fs";

const failures = [];

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts ?? {};

requirePackageValue("name", packageJson.name, "@mirnoorata/codexa");
requirePackageValue("repository.url", repositoryUrl(packageJson), "git+https://github.com/mirnoorata/codexa.git");
requirePackageValue("publishConfig.access", packageJson.publishConfig?.access, "public");

requireScriptContains("release:github:dry-run", ["github-release . --dry-run"]);
requireScriptContains("release:github", ["security:check", "github-release ."]);
requireScriptContains("security:check", ["check", "audit", "public:snapshot-check", "package:hygiene"]);
requireScriptContains("lint", ["verify-codexa-publish.sh"]);

requireText("AGENTS.md", [
  "## GitHub Change and Release Path",
  "push that branch to GitHub",
  "Release Please",
  "RELEASE_PLEASE_TOKEN",
  "npm run release:github",
  "gh release view"
]);
requireText("README.md", [
  "## GitHub Release Timeline",
  "visible source timeline for the current project",
  "npm run release:github",
  "## Release Automation",
  "Release Please",
  "RELEASE_PLEASE_TOKEN",
  "does not publish npm on every main merge",
  "## npm Package Publishing",
  "release: published",
  "npm publish --registry https://registry.npmjs.org --access public --tag latest --provenance --ignore-scripts",
  "changelog-style summary",
  "changed-area summary",
  "forward-only PR rollback commands"
]);
requireText("docs/PUBLIC_RELEASE_CHECKLIST.md", [
  "npm run release:github",
  ".github/workflows/npm-publish.yml",
  ".github/workflows/release-please.yml",
  "release-please-config.json",
  ".release-please-manifest.json",
  "RELEASE_PLEASE_TOKEN",
  "NPM_TOKEN",
  "npm publish --registry https://registry.npmjs.org --access public --tag latest --provenance --ignore-scripts",
  "GitHub Release timeline entry",
  "changelog-style summary",
  "changed-area summary",
  "forward-only rollback branch"
]);
requireText(".github/workflows/npm-publish.yml", [
  "types: [published]",
  "contents: read",
  "id-token: write",
  "permissions:",
  "actions/checkout@v6",
  "ref: ${{ github.event.release.tag_name }}",
  "fetch-depth: 0",
  "actions/setup-node@v6",
  "node-version: \"24.x\"",
  "npm install -g npm@^11.10.0 --registry \"${NPM_REGISTRY}\" --ignore-scripts",
  "RELEASE_PRERELEASE: ${{ github.event.release.prerelease }}",
  "DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
  "git merge-base --is-ancestor HEAD \"refs/remotes/origin/${DEFAULT_BRANCH}\"",
  "npm publishing is stable-release-only",
  "expected_name=\"@mirnoorata/codexa\"",
  "expected_repository=\"git+https://github.com/mirnoorata/codexa.git\"",
  "npm view \"${package_name}@${package_version}\" version --json --registry \"${NPM_REGISTRY}\"",
  "npm run security:check",
  "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
  "PACKAGE_NAME: ${{ steps.package.outputs.name }}",
  "npm view \"${PACKAGE_NAME}@${PACKAGE_VERSION}\" version --json --registry \"${NPM_REGISTRY}\"",
  "npm-view-final.err",
  "was published after the security gate; skipping npm publish.",
  "npm publish --registry \"${NPM_REGISTRY}\" --access public --tag latest --provenance --ignore-scripts"
]);
requireText(".github/workflows/release-please.yml", [
  "name: Release Please",
  "branches: [\"main\"]",
  "contents: write",
  "issues: write",
  "pull-requests: write",
  "github.repository == 'mirnoorata/codexa'",
  "secrets.RELEASE_PLEASE_TOKEN",
  "release: published",
  "googleapis/release-please-action@v4",
  "config-file: release-please-config.json",
  "manifest-file: .release-please-manifest.json"
]);
requireTextCount(".github/workflows/npm-publish.yml", "id-token: write", 1);
requireTextCount(".github/workflows/npm-publish.yml", "ACTIONS_ID_TOKEN_REQUEST_URL: \"\"", 4);
requireTextCount(".github/workflows/npm-publish.yml", "ACTIONS_ID_TOKEN_REQUEST_TOKEN: \"\"", 4);
requireText("release-please-config.json", [
  "\"bootstrap-sha\": \"a37a0f78771a26350239ccd30819d2adf4d67c08\"",
  "\"release-type\": \"node\"",
  "\"include-v-in-tag\": true",
  "\"include-component-in-tag\": false",
  "\"package-name\": \"@mirnoorata/codexa\""
]);
requireText(".release-please-manifest.json", ["\".\": \"0.1.3\""]);
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
requireText("scripts/verify-public-snapshot.mjs", ["--dry-run=false", "--include=dev"]);
requireText("scripts/verify-package-hygiene.mjs", ["--dry-run=false"]);
requireText("scripts/package-install-smoke.mjs", ["--dry-run=false"]);
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

function requirePackageValue(name, actual, expected) {
  if (actual !== expected) {
    failures.push(`package.json ${name} must be ${JSON.stringify(expected)}`);
  }
}

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

function requireTextCount(file, expectedPart, minimumCount) {
  const text = read(file);
  const count = countOccurrences(text, expectedPart);
  if (count < minimumCount) {
    failures.push(`${file} must include ${JSON.stringify(expectedPart)} at least ${minimumCount} time(s); found ${count}`);
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

function countOccurrences(text, part) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(part, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + part.length;
  }
}

function repositoryUrl(pkg) {
  if (typeof pkg.repository === "string") {
    return pkg.repository;
  }
  return pkg.repository?.url;
}
