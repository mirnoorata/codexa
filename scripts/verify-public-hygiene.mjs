#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const scanHistory = process.argv.includes("--history");

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_MATCHES_PER_RULE = 5;
const MAX_FAILURES = 250;

const forbiddenRunbookBasenames = new Set(["CLAUDE.md", "GEMINI.md", "MEMORY.md", "WORKING.md"]);
const forbiddenPathSegments = new Set([`.${"claude"}`, `.${"Codex"}`]);
const workspaceRootPattern = new RegExp(`/${"srv"}(?:/|$)`, "u");
const legacySessionStartPathPattern = new RegExp(`(?:^|/)codexa-${"sessionstart"}-[^/\\s]+\\.sh$`, "iu");

const forbiddenPatterns = [
  { label: "workspace absolute path", pattern: workspaceRootPattern },
  { label: "local home path", pattern: /\/home\/(?!runner\/|node\/|app\/)[a-z][\w-]*(?:\/|$)/iu },
  { label: "non-example GitHub owner in Codexa remote", pattern: /(?:github\.com[:/])(?!example-owner\/|OWNER\/)[A-Za-z0-9_.-]+\/codexa(?:\.git)?/iu },
  { label: "GitHub token", pattern: /\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}\b/u },
  { label: "OpenAI-style API key", pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/u },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/u },
  { label: "npm auth token assignment", pattern: /(?:^|\n)\s*(?:\/\/registry\.npmjs\.org\/:)?_authToken\s*=\s*[^\s'"]{8,}/u },
  { label: "PyPI token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/u },
  { label: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  {
    label: "sensitive env assignment",
    pattern:
      /(?:^|\n)\s*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|PYPI_TOKEN|AWS_SECRET_ACCESS_KEY|DATABASE_URL|POSTGRES_URL|PRIVATE_KEY|SECRET_KEY|SESSION_SECRET|JWT_SECRET)\s*[:=]\s*['"]?[^'"\s]{8,}/iu
  },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u }
];

const failures = [];
let failureLimitReported = false;

if (scanHistory) {
  scanGitHistory();
} else {
  scanCurrentTrackedFiles();
}

if (failures.length > 0) {
  console.error("public-hygiene: tracked files contain publish-blocking environment identifiers");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function scanCurrentTrackedFiles() {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const file of trackedFiles) {
    const stat = safeLstat(file);
    if (!stat) {
      continue;
    }
    const pathBlocked = scanPath({ file });
    if (pathBlocked) {
      continue;
    }
    if (stat.isSymbolicLink()) {
      scanFileText({ file, text: readlinkSync(file), source: "symlink target" });
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const buffer = readFileSync(file);
    if (looksBinary(buffer)) {
      continue;
    }
    scanFileText({ file, text: buffer.toString("utf8") });
  }
}

function scanGitHistory() {
  const revisions = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  scanCommitMetadata(revisions);
  const scannedBlobs = new Set();
  for (const revision of revisions) {
    const entries = execFileSync("git", ["ls-tree", "-r", "-z", revision], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const parsed = parseLsTreeEntry(entry);
      if (!parsed) {
        continue;
      }
      const { file, object, type } = parsed;
      const pathBlocked = scanPath({ revision, file });
      if (pathBlocked) {
        continue;
      }
      if (type !== "blob" || scannedBlobs.has(object)) {
        continue;
      }
      scannedBlobs.add(object);
      const size = Number(execFileSync("git", ["cat-file", "-s", object], { encoding: "utf8" }).trim());
      if (!Number.isFinite(size) || size > MAX_TEXT_BYTES) {
        failures.push(`${formatLocation({ revision, file })}: blob is too large to scan safely`);
        continue;
      }
      const buffer = execFileSync("git", ["cat-file", "-p", object], {
        encoding: "buffer",
        maxBuffer: MAX_TEXT_BYTES
      });
      if (looksBinary(buffer)) {
        continue;
      }
      scanFileText({ revision, file, text: buffer.toString("utf8") });
    }
  }
}

function scanCommitMetadata(revisions) {
  for (const revision of revisions) {
    const text = execFileSync("git", ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%s%n%b", revision], { encoding: "utf8" });
    scanPatternText({ revision, file: "<commit-metadata>", text });
  }
}

function scanPath(input) {
  if (!canRecordMoreFailures()) {
    return false;
  }
  if (isForbiddenRunbookPath(input.file)) {
    recordFailure(`${formatLocation(input)}: remove machine-local runbook or session-memory file from tracked source`);
    return true;
  }
  scanPatternText({ ...input, text: input.file });
  return false;
}

function scanFileText(input) {
  if (!canRecordMoreFailures()) {
    return;
  }
  if (isForbiddenRunbookPath(input.file)) {
    recordFailure(`${formatLocation(input)}: remove machine-local runbook or session-memory file from tracked source`);
    return;
  }
  scanPatternText(input);
}

function scanPatternText(input) {
  if (!canRecordMoreFailures()) {
    return;
  }
  for (const rule of forbiddenPatterns) {
    const pattern = globalPattern(rule.pattern);
    let matchCount = 0;
    let match;
    while ((match = pattern.exec(input.text)) !== null) {
      const line = lineNumberForIndex(input.text, match.index);
      const source = input.source ? `${input.source} ` : "";
      recordFailure(`${formatLocation(input, line)}: ${source}${rule.label}: ${match[0]}`);
      matchCount += 1;
      if (matchCount >= MAX_MATCHES_PER_RULE || !canRecordMoreFailures()) {
        break;
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
    if (!canRecordMoreFailures()) {
      return;
    }
  }
}

function recordFailure(message) {
  if (failures.length < MAX_FAILURES) {
    failures.push(message);
    return;
  }
  if (!failureLimitReported) {
    failures.push("too many hygiene failures; stopping scan early");
    failureLimitReported = true;
  }
}

function canRecordMoreFailures() {
  return failures.length < MAX_FAILURES || !failureLimitReported;
}

function isForbiddenRunbookPath(file) {
  const parts = file.split(/[\\/]+/u).filter(Boolean);
  if (parts.some((part) => forbiddenRunbookBasenames.has(part))) {
    return true;
  }
  return parts.some((part) => forbiddenPathSegments.has(part)) || legacySessionStartPathPattern.test(file);
}

function parseLsTreeEntry(entry) {
  const match = /^(?<mode>\d+)\s+(?<type>\w+)\s+(?<object>[0-9a-f]{40,64})\t(?<file>.+)$/iu.exec(entry);
  if (!match?.groups) {
    return null;
  }
  return {
    file: match.groups.file,
    object: match.groups.object,
    type: match.groups.type
  };
}

function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function formatLocation(input, line) {
  const path = line ? `${input.file}:${line}` : input.file;
  return input.revision ? `${input.revision.slice(0, 12)}:${path}` : path;
}

function looksBinary(buffer) {
  return buffer.includes(0);
}

function safeLstat(file) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}
