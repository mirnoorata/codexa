import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandResult } from "./command.js";
import { parseGithubRemote } from "./github-sync.js";

export interface ProjectGithubReleaseOptions {
  tag?: string;
  title?: string;
  projectName?: string;
  repo?: string;
  remote?: string;
  branch?: string;
  latest?: "auto" | "true" | "false";
  notesFile?: string;
  dryRun?: boolean;
  push?: boolean;
  createTag?: boolean;
  githubRelease?: boolean;
  allowDirty?: boolean;
  allowNonMain?: boolean;
  timeoutMs?: number;
}

export interface ProjectGithubReleaseData {
  repoRoot: string;
  projectName: string;
  projectSlug: string;
  branch: string | null;
  localHead: string;
  tag: string;
  title: string;
  githubRepo: string | null;
  releaseUrl: string | null;
  dirtyFileCount: number;
  dryRun: boolean;
  notesFile: string;
  actions: string[];
  warnings: string[];
}

interface ReleaseCommit {
  sha: string;
  subject: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CHANGED_AREA_FILES = 8;

export async function publishProjectGithubRelease(
  repoInput: string,
  options: ProjectGithubReleaseOptions = {}
): Promise<{ text: string; data: ProjectGithubReleaseData }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remoteName = options.remote ?? "origin";
  const dryRun = options.dryRun ?? false;
  const createTag = options.createTag ?? true;
  const push = options.push ?? true;
  const githubRelease = options.githubRelease ?? true;
  const latestMode = options.latest ?? "auto";
  if (!["auto", "true", "false"].includes(latestMode)) {
    throw new Error("--latest must be one of: auto, true, false");
  }
  if (githubRelease && !push && !dryRun && !options.notesFile) {
    throw new Error("GitHub Release creation requires pushed tags; pass --push or --no-github-release.");
  }

  const repoRoot = await resolveGitRoot(repoInput, timeoutMs);
  const localHead = await gitText(repoRoot, ["rev-parse", "HEAD"], "resolve HEAD", timeoutMs);
  const shortHead = localHead.slice(0, 7);
  const currentBranch = nonEmpty(await gitText(repoRoot, ["branch", "--show-current"], "resolve current branch", timeoutMs, true));
  const branch = options.branch ?? currentBranch;
  const projectName = options.projectName?.trim() || (await defaultProjectName(repoRoot));
  const projectSlug = sanitizeReleaseRef(projectName.toLowerCase());
  const tag = options.tag ?? (await defaultReleaseTag(repoRoot, shortHead, projectSlug));
  const title = options.title ?? `${projectName} ${tag}`;
  const remoteUrl = await gitText(repoRoot, ["remote", "get-url", remoteName], `resolve ${remoteName} remote`, timeoutMs, true);
  const githubRepo = options.repo ?? (remoteUrl ? parseGithubRemote(remoteUrl) : null);
  const warnings: string[] = [];
  const actions: string[] = [];

  const dirtyFileCount = await dirtyCount(repoRoot, timeoutMs);
  if (dirtyFileCount > 0 && !options.allowDirty) {
    const message = `working tree has ${dirtyFileCount} dirty file(s); commit or stash before creating a GitHub release`;
    if (dryRun || options.notesFile) {
      warnings.push(message);
    } else {
      throw new Error(message);
    }
  }
  if (currentBranch !== "main" && !options.allowNonMain) {
    const message = `current branch is ${currentBranch ?? "detached"}, not main; release from main or pass --allow-non-main`;
    if (dryRun || options.notesFile) {
      warnings.push(message);
    } else {
      throw new Error(message);
    }
  }
  if (!githubRepo && (push || githubRelease)) {
    const message = "Could not infer GitHub repository from origin. Pass --repo OWNER/REPO.";
    if (dryRun || options.notesFile) {
      warnings.push(message);
    } else {
      throw new Error(message);
    }
  }

  const tagStatus = await localTagStatus(repoRoot, tag, localHead, timeoutMs);
  if (tagStatus === "different") {
    throw new Error(`tag ${tag} already exists and does not point at HEAD ${shortHead}`);
  }
  if (!createTag && tagStatus === "missing") {
    const message = `tag ${tag} does not exist locally and --no-create-tag was passed`;
    if (dryRun || options.notesFile) {
      warnings.push(message);
    } else {
      throw new Error(message);
    }
  }
  const shouldPushTag = tagStatus === "same" || createTag;
  if (createTag) {
    if (tagStatus === "same") {
      actions.push(`tag already exists locally: ${tag}`);
    } else if (dryRun || options.notesFile) {
      actions.push(`would create annotated tag ${tag} at ${shortHead}`);
    }
  } else {
    actions.push("tag creation skipped");
  }

  if (push && !dryRun && !options.notesFile) {
    if (!branch) {
      throw new Error("Cannot push a release without a branch. Check out main or pass --branch.");
    }
    await assertOk(await git(repoRoot, ["fetch", "--quiet", remoteName, branch, "--tags"], timeoutMs), `fetch ${remoteName}/${branch}`);
    const originBranch = `${remoteName}/${branch}`;
    const revList = await git(repoRoot, ["rev-list", "--left-right", "--count", `HEAD...${originBranch}`], timeoutMs);
    await assertOk(revList, `compare HEAD with ${originBranch}`);
    const [ahead = "0", behind = "0"] = revList.stdout.trim().split(/\s+/u);
    if (behind !== "0") {
      throw new Error(`local ${branch} is behind ${originBranch} by ${behind} commit(s); pull with --ff-only before release`);
    }
    if (ahead !== "0") {
      actions.push(`local ${branch} is ahead of ${originBranch} by ${ahead} commit(s)`);
    }
    if (shouldPushTag && tagStatus === "missing") {
      const remoteTag = await git(repoRoot, ["ls-remote", "--exit-code", "--tags", remoteName, `refs/tags/${tag}`], timeoutMs);
      if (remoteTag.ok) {
        throw new Error(`remote tag already exists: ${tag}`);
      }
    }
    await assertOk(await git(repoRoot, ["push", "--dry-run", remoteName, `HEAD:${branch}`], timeoutMs), `dry-run push ${branch}`);
    if (githubRelease) {
      await assertOk(await runCommand("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs, maxBufferBytes: 32 * 1024, env: noPromptEnv() }), "check gh auth");
      await assertOk(await runCommand("gh", ["repo", "view", githubRepo!], { timeoutMs, maxBufferBytes: 32 * 1024, env: noPromptEnv() }), `check GitHub repo ${githubRepo}`);
    }
  } else if (push) {
    actions.push(`would push ${branch ?? "current branch"}${shouldPushTag ? ` and ${tag}` : ""} to ${remoteName}`);
  } else {
    actions.push("push skipped");
  }

  const notesFile = options.notesFile ? path.resolve(options.notesFile) : path.join(await fs.mkdtemp(path.join(os.tmpdir(), `${projectSlug}-release-notes-`)), "notes.md");
  await writeProjectReleaseNotes(repoRoot, {
    projectName,
    projectSlug,
    tag,
    title,
    githubRepo,
    notesFile,
    timeoutMs
  });
  actions.push(`release notes ${options.notesFile ? "written" : "generated"}: ${notesFile}`);

  if (options.notesFile) {
    actions.push("stopped after writing notes file");
  } else if (!dryRun) {
    if (createTag && tagStatus === "missing") {
      await assertOk(
        await git(repoRoot, ["tag", "-a", tag, localHead, "-m", title, "-m", `Commit: ${localHead}`], timeoutMs),
        `create tag ${tag}`
      );
      actions.push(`created tag ${tag}`);
    }
    if (push) {
      await assertOk(await git(repoRoot, ["push", remoteName, `HEAD:${branch}`], timeoutMs), `push ${branch}`);
      actions.push(`pushed ${branch} to ${remoteName}`);
      if (shouldPushTag) {
        await assertOk(await git(repoRoot, ["push", remoteName, `refs/tags/${tag}`], timeoutMs), `push tag ${tag}`);
        actions.push(`pushed tag ${tag} to ${remoteName}`);
      }
    }
    if (githubRelease) {
      await createOrUpdateGithubRelease(githubRepo!, tag, title, notesFile, latestMode, timeoutMs, actions);
    }
  } else if (githubRelease) {
    actions.push(`would create or update GitHub Release ${tag}`);
  }

  const releaseUrl = githubRepo ? `https://github.com/${githubRepo}/releases/tag/${tag}` : null;
  const data: ProjectGithubReleaseData = {
    repoRoot,
    projectName,
    projectSlug,
    branch,
    localHead,
    tag,
    title,
    githubRepo,
    releaseUrl,
    dirtyFileCount,
    dryRun,
    notesFile,
    actions,
    warnings
  };
  return { text: renderProjectGithubRelease(data), data };
}

export async function writeProjectReleaseNotes(
  repoRoot: string,
  input: { projectName?: string; projectSlug?: string; tag: string; title: string; githubRepo: string | null; notesFile: string; timeoutMs?: number }
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const projectName = input.projectName?.trim() || (await defaultProjectName(repoRoot));
  const projectSlug = sanitizeReleaseRef((input.projectSlug?.trim() || projectName).toLowerCase());
  const commitSha = await gitText(repoRoot, ["rev-parse", `${input.tag}^{commit}`], "resolve release commit", timeoutMs, true);
  const effectiveCommit = commitSha || (await gitText(repoRoot, ["rev-parse", "HEAD"], "resolve HEAD", timeoutMs));
  const releaseRevision = commitSha ? input.tag : effectiveCommit;
  const commitDate = await gitText(repoRoot, ["show", "-s", "--format=%cI", effectiveCommit], "resolve commit date", timeoutMs, true);
  const previousTag = await previousProjectReleaseTag(repoRoot, input.tag, timeoutMs);
  const releaseToken = sanitizeReleaseRef(input.tag);
  const compareUrl =
    input.githubRepo && previousTag
      ? `https://github.com/${input.githubRepo}/compare/${previousTag}...${input.tag}`
      : null;
  const changedFiles = previousTag
    ? await gitText(repoRoot, ["diff", "--stat", `${previousTag}..${releaseRevision}`], "diff previous release", timeoutMs, true)
    : await gitText(repoRoot, ["show", "--stat", "--format=", releaseRevision], "show release stat", timeoutMs, true);
  const changedFileList = await releaseChangedFiles(repoRoot, previousTag, releaseRevision, timeoutMs);
  const releaseCommits = await releaseCommitList(repoRoot, previousTag, releaseRevision, timeoutMs);

  const notes = [
    `${projectName} release timeline entry for \`${input.tag}\`.`,
    "",
    "## Version",
    "",
    `- Tag: \`${input.tag}\``,
    `- Commit: \`${effectiveCommit.slice(0, 7)}\``,
    `- Commit date: \`${commitDate || "unknown"}\``,
    compareUrl ? `- Compare from previous release: ${compareUrl}` : undefined,
    "",
    "## Changelog",
    "",
    ...renderChangelog(releaseCommits, input.githubRepo),
    "",
    "## Changed Areas",
    "",
    ...renderChangedAreaSummary(changedFileList),
    "",
    "## Continue From This Version",
    "",
    "Create a safe branch at this exact release point:",
    "",
    "```bash",
    "git fetch --all --tags --prune",
    `git switch -c ${projectSlug}-from-${releaseToken} ${input.tag}`,
    "```",
    "",
    "Or inspect it without disturbing your current worktree:",
    "",
    "```bash",
    "git fetch --all --tags --prune",
    `git worktree add /path/to/${projectSlug}-${releaseToken} ${input.tag}`,
    "```",
    "",
    "## Restore From GitHub",
    "",
    input.githubRepo
      ? "Recreate a clean checkout from GitHub at this exact release tag:"
      : "Restore from any remote that contains this exact release tag:",
    "",
    "```bash",
    input.githubRepo ? `git clone https://github.com/${input.githubRepo}.git ${projectSlug}-${releaseToken}` : "git fetch --all --tags --prune",
    input.githubRepo ? `cd ${projectSlug}-${releaseToken}` : undefined,
    input.githubRepo ? "git fetch --tags --prune" : undefined,
    `git switch --detach ${input.tag}`,
    "```",
    "",
    "## Revert Changes Via PR",
    "",
    "Use a forward-only revert branch so main history stays intact:",
    "",
    "```bash",
    "git fetch --all --tags --prune",
    "git switch main",
    "git pull --ff-only origin main",
    `git switch -c revert/${projectSlug}-${releaseToken}`,
    `git revert --no-commit ${input.tag}..HEAD`,
    "git add -A",
    `git commit -m "Revert ${projectName} to ${input.tag}"`,
    `git push origin revert/${projectSlug}-${releaseToken}`,
    "```",
    "",
    "## Changed Files",
    "",
    "```text",
    changedFiles.trim() || "No file summary recorded.",
    "```",
    "",
    "## Commits Since Previous Release",
    "",
    "```text",
    renderRawCommitList(releaseCommits) || "No commits recorded.",
    "```",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  await fs.mkdir(path.dirname(input.notesFile), { recursive: true });
  await fs.writeFile(input.notesFile, notes, "utf8");
}

async function releaseCommitList(repoRoot: string, previousTag: string | null, releaseRevision: string, timeoutMs: number): Promise<ReleaseCommit[]> {
  const args = previousTag
    ? ["log", "--format=%H%x1f%s%x1e", `${previousTag}..${releaseRevision}`]
    : ["log", "--format=%H%x1f%s%x1e", "-1", releaseRevision];
  const raw = await gitText(repoRoot, args, "log release commits", timeoutMs, true);
  return parseReleaseCommitList(raw);
}

function parseReleaseCommitList(raw: string): ReleaseCommit[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", ...subjectParts] = record.split("\x1f");
      const subject = subjectParts.join("\x1f").trim();
      return sha && subject ? { sha: sha.trim(), subject } : null;
    })
    .filter((commit): commit is ReleaseCommit => commit !== null);
}

async function releaseChangedFiles(repoRoot: string, previousTag: string | null, releaseRevision: string, timeoutMs: number): Promise<string[]> {
  const args = previousTag
    ? ["diff", "--name-only", `${previousTag}..${releaseRevision}`]
    : ["show", "--name-only", "--format=", releaseRevision];
  const raw = await gitText(repoRoot, args, "list release changed files", timeoutMs, true);
  const seen = new Set<string>();
  const files: string[] = [];
  for (const file of raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function renderChangelog(commits: ReleaseCommit[], githubRepo: string | null): string[] {
  if (commits.length === 0) {
    return ["No commit summaries recorded."];
  }

  const grouped = new Map<string, ReleaseCommit[]>();
  for (const commit of commits) {
    const category = changelogCategory(commit.subject);
    grouped.set(category, [...(grouped.get(category) ?? []), commit]);
  }

  const lines: string[] = [];
  for (const title of changelogCategoryOrder()) {
    const categoryCommits = grouped.get(title);
    if (!categoryCommits || categoryCommits.length === 0) {
      continue;
    }
    lines.push(`### ${title}`, "");
    lines.push(...categoryCommits.map((commit) => formatCommitBullet(commit, githubRepo)));
    lines.push("");
  }
  return trimTrailingBlank(lines);
}

function changelogCategory(subject: string): string {
  const normalized = subject.toLowerCase();
  if (/\b(dependabot|bump|dependency|dependencies|package-lock|npm audit|vulnerab|cve|security)\b/u.test(normalized)) {
    return "Dependencies and security";
  }
  if (/\b(readme|docs?|checklist|guide|runbook|contributing|security policy)\b/u.test(normalized)) {
    return "Documentation";
  }
  if (/\b(test|tests|verify|verification|check|smoke|benchmark|ci|lint|typecheck|fixture)\b/u.test(normalized)) {
    return "Tests and verification";
  }
  if (/\b(release|publish|github release|tag|rollback|revert path|changelog|package hygiene)\b/u.test(normalized)) {
    return "Release and publishing";
  }
  if (/\b(cli|command|hook|mcp|session-start|plugin|integration|claude|codex)\b/u.test(normalized)) {
    return "CLI, hooks, and integrations";
  }
  if (/\b(context|brief|change[- ]plans?|query|retrieval|index|parser|graph|snapshot|candidates?|semantic|lsp|session memory)\b/u.test(normalized)) {
    return "Codexa context engine";
  }
  return "Code and behavior";
}

function changelogCategoryOrder(): string[] {
  return [
    "Release and publishing",
    "Dependencies and security",
    "CLI, hooks, and integrations",
    "Codexa context engine",
    "Code and behavior",
    "Tests and verification",
    "Documentation"
  ];
}

function formatCommitBullet(commit: ReleaseCommit, githubRepo: string | null): string {
  const shortSha = commit.sha.slice(0, 7);
  const commitRef = githubRepo ? `[${shortSha}](https://github.com/${githubRepo}/commit/${commit.sha})` : `\`${shortSha}\``;
  return `- ${commitRef} ${commit.subject}`;
}

function renderChangedAreaSummary(files: string[]): string[] {
  if (files.length === 0) {
    return ["No changed file paths recorded."];
  }

  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const area = changedArea(file);
    grouped.set(area, [...(grouped.get(area) ?? []), file]);
  }

  const lines: string[] = [];
  for (const title of changedAreaOrder()) {
    const areaFiles = grouped.get(title);
    if (!areaFiles || areaFiles.length === 0) {
      continue;
    }
    const visibleFiles = areaFiles.slice(0, MAX_CHANGED_AREA_FILES).map((file) => `\`${file}\``).join(", ");
    const extraCount = areaFiles.length - MAX_CHANGED_AREA_FILES;
    const suffix = extraCount > 0 ? `, plus ${extraCount} more` : "";
    lines.push(`- ${title}: ${visibleFiles}${suffix}`);
  }
  return lines;
}

function changedArea(file: string): string {
  const normalized = file.replace(/\\/gu, "/");
  if (
    normalized === "src/github-release.ts" ||
    normalized === "scripts/verify-release-path.mjs" ||
    normalized === "docs/PUBLIC_RELEASE_CHECKLIST.md" ||
    normalized === ".github/workflows/check.yml"
  ) {
    return "Release and publishing";
  }
  if (
    normalized === "src/cli.ts" ||
    normalized === "src/mcp.ts" ||
    normalized === "src/init.ts" ||
    normalized.startsWith("integrations/") ||
    normalized.startsWith("plugins/")
  ) {
    return "CLI, hooks, and integrations";
  }
  if (
    normalized.startsWith("src/query/") ||
    normalized === "src/queries.ts" ||
    normalized === "src/indexer.ts" ||
    normalized === "src/parser.ts" ||
    normalized === "src/retrieval.ts" ||
    normalized === "src/graph.ts" ||
    normalized === "src/task-snapshots.ts" ||
    normalized === "src/semantic-retrieval.ts" ||
    normalized.startsWith("src/semantic/") ||
    normalized.startsWith("src/lsp/")
  ) {
    return "Codexa context engine";
  }
  if (normalized.startsWith("tests/") || normalized === "vitest.config.ts" || normalized.startsWith("scripts/verify-")) {
    return "Tests and verification";
  }
  if (
    normalized === "README.md" ||
    normalized === "AGENTS.md" ||
    normalized === "CONTRIBUTING.md" ||
    normalized === "SECURITY.md" ||
    normalized === "CODE_OF_CONDUCT.md" ||
    normalized.startsWith("docs/")
  ) {
    return "Documentation";
  }
  if (
    normalized === "package.json" ||
    normalized === "package-lock.json" ||
    normalized === ".npmrc" ||
    normalized.startsWith("scripts/package-") ||
    normalized.startsWith("scripts/prepare-")
  ) {
    return "Dependencies and packaging";
  }
  if (normalized.startsWith("src/")) {
    return "Code and behavior";
  }
  return "Other files";
}

function changedAreaOrder(): string[] {
  return [
    "Release and publishing",
    "Dependencies and packaging",
    "CLI, hooks, and integrations",
    "Codexa context engine",
    "Code and behavior",
    "Tests and verification",
    "Documentation",
    "Other files"
  ];
}

function renderRawCommitList(commits: ReleaseCommit[]): string {
  return commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join("\n");
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function sanitizeReleaseRef(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "release";
}

async function defaultProjectName(repoRoot: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim()) {
      return packageNameToProjectName(parsed.name.trim());
    }
  } catch {
    // Fall through to the directory name for non-package repositories.
  }
  return path.basename(repoRoot) || "project";
}

function packageNameToProjectName(value: string): string {
  const bareName = value.startsWith("@") ? value.split("/").at(-1) : value;
  return (bareName ?? value).trim() || "project";
}

async function defaultReleaseTag(repoRoot: string, shortHead: string, projectSlug: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return `v${parsed.version.trim()}`;
    }
  } catch {
    // Fall through to a deterministic source tag.
  }
  return `${projectSlug}-release-${new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}-${shortHead}`;
}

async function previousProjectReleaseTag(repoRoot: string, current: string, timeoutMs: number): Promise<string | null> {
  const tags = await gitText(repoRoot, ["tag", "--list", "v[0-9]*", "--sort=-version:refname"], "list release tags", timeoutMs, true);
  const list = tags.split(/\r?\n/u).filter(Boolean);
  const currentIndex = list.indexOf(current);
  if (currentIndex >= 0) {
    return list[currentIndex + 1] ?? null;
  }
  return list.find((tag) => tag !== current) ?? null;
}

async function createOrUpdateGithubRelease(
  githubRepo: string,
  tag: string,
  title: string,
  notesFile: string,
  latestMode: "auto" | "true" | "false",
  timeoutMs: number,
  actions: string[]
): Promise<void> {
  await assertOk(await runCommand("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs, maxBufferBytes: 32 * 1024, env: noPromptEnv() }), "check gh auth");
  const view = await runCommand("gh", ["release", "view", tag, "-R", githubRepo], { timeoutMs, maxBufferBytes: 32 * 1024, env: noPromptEnv() });
  const createLatestArgs = latestMode === "true" ? ["--latest"] : latestMode === "false" ? ["--latest=false"] : [];
  const editLatestArgs = latestMode === "true" ? ["--latest"] : [];
  if (view.ok) {
    await assertOk(
      await runCommand("gh", ["release", "edit", tag, "-R", githubRepo, "--title", title, "--notes-file", notesFile, ...editLatestArgs], {
        timeoutMs,
        maxBufferBytes: 64 * 1024,
        env: noPromptEnv()
      }),
      `edit GitHub Release ${tag}`
    );
    actions.push(`updated GitHub Release ${tag}`);
    return;
  }
  await assertOk(
    await runCommand("gh", ["release", "create", tag, "-R", githubRepo, "--verify-tag", "--title", title, "--notes-file", notesFile, ...createLatestArgs], {
      timeoutMs,
      maxBufferBytes: 64 * 1024,
      env: noPromptEnv()
    }),
    `create GitHub Release ${tag}`
  );
  actions.push(`created GitHub Release ${tag}`);
}

async function localTagStatus(repoRoot: string, tag: string, head: string, timeoutMs: number): Promise<"missing" | "same" | "different"> {
  const tagResult = await git(repoRoot, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], timeoutMs);
  if (!tagResult.ok) {
    return "missing";
  }
  const tagCommit = await gitText(repoRoot, ["rev-parse", `${tag}^{commit}`], `resolve tag ${tag}`, timeoutMs);
  return tagCommit === head ? "same" : "different";
}

async function dirtyCount(repoRoot: string, timeoutMs: number): Promise<number> {
  const status = await gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "read git status", timeoutMs);
  return status.split(/\r?\n/u).filter(Boolean).length;
}

async function resolveGitRoot(repoInput: string, timeoutMs: number): Promise<string> {
  const initialRepo = path.resolve(repoInput || process.cwd());
  const root = await gitText(initialRepo, ["rev-parse", "--show-toplevel"], "resolve git root", timeoutMs);
  return root;
}

async function gitText(repoRoot: string, args: string[], label: string, timeoutMs: number, allowFailure = false): Promise<string> {
  const result = await git(repoRoot, args, timeoutMs);
  if (!result.ok) {
    if (allowFailure) {
      return "";
    }
    throw new Error(`${label} failed: ${summarizeCommand(result)}`);
  }
  return result.stdout.trim();
}

async function git(repoRoot: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return await runCommand("git", ["-C", repoRoot, ...args], {
    timeoutMs,
    maxBufferBytes: 512 * 1024,
    env: noPromptEnv()
  });
}

async function assertOk(result: CommandResult, label: string): Promise<void> {
  if (!result.ok) {
    throw new Error(`${label} failed: ${summarizeCommand(result)}`);
  }
}

function renderProjectGithubRelease(data: ProjectGithubReleaseData): string {
  const lines = [
    `${data.projectName} GitHub release`,
    `Repo: ${data.repoRoot}`,
    `Project: ${data.projectName}`,
    `GitHub repo: ${data.githubRepo ?? "unknown"}`,
    `Branch: ${data.branch ?? "unknown"}`,
    `Tag: ${data.tag}`,
    `Commit: ${data.localHead.slice(0, 12)}`,
    `Working tree dirty files: ${data.dirtyFileCount}`,
    `Mode: ${data.dryRun ? "dry-run" : "apply"}`,
    data.releaseUrl ? `Release URL: ${data.releaseUrl}` : undefined,
    "",
    data.warnings.length > 0 ? "Warnings:" : undefined,
    ...data.warnings.map((warning) => `- ${warning}`),
    data.warnings.length > 0 ? "" : undefined,
    "Actions:",
    ...data.actions.map((action) => `- ${action}`),
    "",
    "Revert path:",
    `- Open ${data.releaseUrl ?? "the generated release notes"} and use "Revert Changes Via PR" for forward-only rollback commands.`
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function summarizeCommand(result: CommandResult): string {
  if (result.timedOut) {
    return "timed out";
  }
  if (result.truncated) {
    return "output truncated";
  }
  const text = `${result.stderr}\n${result.stdout}\n${result.error?.message ?? ""}`.trim().replace(/\s+/gu, " ");
  return text ? redactSensitiveText(text).slice(0, 240) : `exit ${result.exitCode ?? "unknown"}`;
}

function noPromptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never"
  };
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/https:\/\/[^/@\s]+@github\.com\//giu, "https://github.com/")
    .replace(/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{8,}\b/gu, "[REDACTED_TOKEN]");
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}
