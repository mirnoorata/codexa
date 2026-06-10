#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pluginRoot = path.join(root, "plugins", "codexa");
const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "scripts/codexa-mcp.js",
  "skills/codexa/SKILL.md"
];
const failures = [];
const packedFileSet = npmPackFileSet();

for (const file of requiredFiles) {
  const fullPath = path.join(pluginRoot, file);
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile()) {
      failures.push(`${file} is not a file`);
    }
  } catch {
    failures.push(`${file} is missing`);
  }
  requireField(packedFileSet?.has(`plugins/codexa/${file}`) === true, `${file} is missing from npm pack output`);
}

const manifest = parseJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), "plugin manifest");
if (manifest) {
  requireField(manifest.name === "codexa", "plugin manifest name must be codexa");
  requireField(typeof manifest.version === "string" && manifest.version.length > 0, "plugin manifest version is required");
  requireField(manifest.skills === "./skills/", "plugin manifest skills path must point at ./skills/");
  requireField(manifest.mcpServers === "./.mcp.json", "plugin manifest mcpServers must point at ./.mcp.json");
  requireField(manifest.interface?.displayName === "Codexa", "plugin interface displayName must be Codexa");
}

const mcpConfig = parseJson(path.join(pluginRoot, ".mcp.json"), "plugin MCP config");
if (mcpConfig) {
  const server = mcpConfig.mcpServers?.codexa;
  requireField(server?.command === "node", "plugin MCP server must launch node");
  requireField(Array.isArray(server?.args) && server.args.includes("./scripts/codexa-mcp.js"), "plugin MCP server must launch scripts/codexa-mcp.js");
  requireField(Array.isArray(server?.env_vars) && server.env_vars.includes("CODEXA_REPO"), "plugin MCP server must expose CODEXA_REPO");
  requireField(Array.isArray(server?.env_vars) && server.env_vars.includes("CODEXA_FOCUSED_REPO"), "plugin MCP server must expose CODEXA_FOCUSED_REPO");
  requireField(Array.isArray(server?.env_vars) && server.env_vars.includes("CODEXA_WORKSPACE_FOCUS_FILE"), "plugin MCP server must expose CODEXA_WORKSPACE_FOCUS_FILE");
}

const marketplace = parseJson(marketplacePath, "plugin marketplace");
if (marketplace) {
  const plugin = Array.isArray(marketplace.plugins) ? marketplace.plugins.find((entry) => entry?.name === "codexa") : undefined;
  requireField(marketplace.name === "codexa-local", "plugin marketplace name must be codexa-local");
  requireField(plugin?.source?.path === "./plugins/codexa", "plugin marketplace must point codexa at ./plugins/codexa");
  requireField(plugin?.policy?.installation === "AVAILABLE", "plugin marketplace installation policy must be AVAILABLE");
}

try {
  accessSync(path.join(pluginRoot, "scripts/codexa-mcp.js"), constants.X_OK);
} catch {
  failures.push("scripts/codexa-mcp.js must be executable");
}

for (const file of requiredFiles) {
  scanText(file, readFileSync(path.join(pluginRoot, file), "utf8"));
}
const skillText = readFileSync(path.join(pluginRoot, "skills/codexa/SKILL.md"), "utf8");
validateSkillFrontmatter("skills/codexa/SKILL.md", skillText);
validateCodexaSkillContract("skills/codexa/SKILL.md", skillText);
scanText(".agents/plugins/marketplace.json", readFileSync(marketplacePath, "utf8"));

if (failures.length > 0) {
  console.error("plugin-package: verification failed");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("plugin-package: Codexa plugin package passed");

function parseJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function requireField(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function npmPackFileSet() {
  try {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsed = JSON.parse(output);
    const files = Array.isArray(parsed?.[0]?.files) ? parsed[0].files : [];
    return new Set(files.map((entry) => entry?.path).filter((entry) => typeof entry === "string"));
  } catch (error) {
    failures.push(`npm pack dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function scanText(file, text) {
  const blocked = [
    /\[TODO[^\]]*\]/iu,
    /\bTODO\b/u,
    new RegExp(`/${"srv"}(?=$|[/\\s,.;:)\\]}])`, "u"),
    /\/home\/[a-z][\w-]*(?=$|[\/\s,.;:)\]}])/iu
  ];
  for (const pattern of blocked) {
    if (pattern.test(text)) {
      failures.push(`${file} contains blocked scaffold or local-path text matching ${pattern}`);
    }
  }
}

function validateSkillFrontmatter(file, text) {
  if (!text.startsWith("---\n")) {
    failures.push(`${file} must start with YAML frontmatter`);
    return;
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    failures.push(`${file} must close YAML frontmatter with ---`);
    return;
  }
  const frontmatter = text.slice(4, end).trim();
  const fields = new Map();
  for (const line of frontmatter.split(/\r?\n/u)) {
    const match = /^([a-z][a-z0-9_-]*):\s*(.*)$/iu.exec(line);
    if (!match) {
      failures.push(`${file} contains unsupported skill frontmatter line: ${line}`);
      continue;
    }
    fields.set(match[1], match[2]);
  }
  for (const field of ["name", "description"]) {
    const value = fields.get(field);
    if (typeof value !== "string" || value.trim().length === 0) {
      failures.push(`${file} skill frontmatter must include ${field}`);
    }
  }
}

function validateCodexaSkillContract(file, text) {
  const requiredSnippets = [
    "session_context -> search(if target unclear) -> task_brief -> change_plan(saveSnapshot) -> post_edit_review -> test_plan",
    "Keep host adapters thin",
    "no source-mutating MCP tool path",
    "codexa search . --query"
  ];
  for (const snippet of requiredSnippets) {
    requireField(text.includes(snippet), `${file} must include Codexa thin-adapter contract text: ${snippet}`);
  }
}
