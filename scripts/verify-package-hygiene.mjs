#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_FAILURES = 250;
const targets = process.argv.slice(2);
const failures = [];
const localPathTerminator = String.raw`(?=$|[/\s,.;:)\]}])`;

const forbiddenPatterns = [
  { label: "workspace absolute path", pattern: new RegExp(`/${"srv"}${localPathTerminator}`, "u") },
  { label: "local home path", pattern: new RegExp(String.raw`/home/(?!runner/|node/|app/)[a-z][\w-]*${localPathTerminator}`, "iu") },
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

if (targets.length > 0) {
  for (const target of targets) {
    scanDirectory(path.resolve(target), path.basename(target));
  }
} else {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codexa-package-hygiene-"));
  try {
    const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", tempDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const entries = JSON.parse(packJson);
    const tarball = path.join(tempDir, entries[0]?.filename ?? "");
    execFileSync("tar", ["-xzf", tarball, "-C", tempDir], { stdio: "ignore" });
    scanDirectory(path.join(tempDir, "package"), "npm-package");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error("package-hygiene: generated publish contents contain blocked environment identifiers");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("package-hygiene: generated publish contents passed");

function scanDirectory(directory, label) {
  const stat = statSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`package hygiene target is not a directory: ${directory}`);
  }
  for (const file of walk(directory)) {
    if (failures.length >= MAX_FAILURES) {
      return;
    }
    const relative = path.relative(directory, file).split(path.sep).join("/");
    scanText(`${label}/${relative}`, relative);
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink()) {
      scanText(`${label}/${relative}`, readlinkSync(file));
      continue;
    }
    if (!fileStat.isFile()) {
      continue;
    }
    if (fileStat.size > MAX_TEXT_BYTES) {
      recordFailure(`${label}/${relative}: file is too large to scan safely`);
      continue;
    }
    const buffer = readFileSync(file);
    if (buffer.includes(0)) {
      continue;
    }
    scanText(`${label}/${relative}`, buffer.toString("utf8"));
  }
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield fullPath;
    }
  }
}

function scanText(location, text) {
  for (const rule of forbiddenPatterns) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let match;
    while ((match = pattern.exec(text)) !== null) {
      recordFailure(`${location}:${lineNumberForIndex(text, match.index)}: ${rule.label}: <redacted>`);
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
      if (failures.length >= MAX_FAILURES) {
        return;
      }
    }
  }
}

function recordFailure(message) {
  if (failures.length < MAX_FAILURES) {
    failures.push(message);
  }
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/u).length;
}
