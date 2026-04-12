#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenFiles = new Set(["CLAUDE.md", "GEMINI.md", "MEMORY.md", "WORKING.md"]);
const workspaceRootPattern = new RegExp(`/${"srv"}(?:/|$)`, "u");

const forbiddenPatterns = [
  { label: "workspace absolute path", pattern: workspaceRootPattern },
  { label: "local home path", pattern: /\/home\/(?!runner\/|node\/|app\/)[a-z][\w-]*(?:\/|$)/iu },
  { label: "non-example GitHub owner in Codexa remote", pattern: /(?:github\.com[:/])(?!example-owner\/|OWNER\/)[A-Za-z0-9_.-]+\/codexa(?:\.git)?/iu },
  { label: "GitHub token", pattern: /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/u },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u }
];

const failures = [];

for (const file of trackedFiles) {
  if (!existsSync(file)) {
    continue;
  }
  if (forbiddenFiles.has(file)) {
    failures.push(`${file}: remove machine-local runbook or session-memory file from tracked source`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const rule of forbiddenPatterns) {
    const match = rule.pattern.exec(text);
    if (match) {
      const line = lineNumberForIndex(text, match.index);
      failures.push(`${file}:${line}: ${rule.label}: ${match[0]}`);
    }
  }
}

if (failures.length > 0) {
  console.error("public-hygiene: tracked files contain publish-blocking environment identifiers");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}
