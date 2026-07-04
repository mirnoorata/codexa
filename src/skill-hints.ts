import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexaIndex } from "./types.js";
import { limitText, uniqueSorted } from "./util.js";

export const SKILL_HINTS_RELATIVE_PATH = ".codex/skill-hints.json";

export interface SkillHintsConfigV1 {
  schemaVersion: 1;
  skillRoots?: string[];
  hints?: Array<{
    glob?: string;
    globs?: string[];
    skills: string[];
  }>;
}

export interface ScannedSkillHint {
  name: string;
  root: string;
  path: string;
  description?: string;
}

export interface ApplicableSkillHint {
  name: string;
  matchedGlob: string;
  matchedPath: string;
  description?: string;
  skillPath?: string;
}

export interface TargetPlaybookHint {
  module: string;
  uri: string;
  path: string;
}

export interface SkillHintsSummary {
  configPath: string;
  configured: boolean;
  roots: string[];
  scannedSkills: ScannedSkillHint[];
  hints: Array<{ globs: string[]; skills: string[] }>;
  warnings: string[];
}

const MAX_ROOTS = 12;
const MAX_ROOT_ENTRIES = 160;
const MAX_SKILLS = 200;
const MAX_HINTS = 80;
const MAX_HINT_SKILLS = 12;
const MAX_GLOBS_PER_HINT = 12;
const MAX_SKILL_FILE_BYTES = 64 * 1024;

export async function loadSkillHints(repoRoot: string): Promise<SkillHintsSummary> {
  const repo = path.resolve(repoRoot);
  const configPath = path.join(repo, SKILL_HINTS_RELATIVE_PATH);
  const warnings: string[] = [];
  const config = await readSkillHintsConfig(configPath, warnings);
  if (!config) {
    return { configPath: SKILL_HINTS_RELATIVE_PATH, configured: false, roots: [], scannedSkills: [], hints: [], warnings };
  }

  const allowedRoots = allowedSkillRootPrefixes(repo);
  const configuredRoots = arrayConfig(config.skillRoots, "skillRoots", warnings);
  const roots = uniqueSorted(configuredRoots.flatMap((root) => resolveConfiguredRoot(root, repo, allowedRoots, warnings))).slice(0, MAX_ROOTS);
  const scannedSkills: ScannedSkillHint[] = [];
  for (const root of roots) {
    scannedSkills.push(...(await scanSkillRoot(root, repo, allowedRoots, warnings)));
    if (scannedSkills.length >= MAX_SKILLS) {
      warnings.push(`skill scan capped at ${MAX_SKILLS} entries`);
      break;
    }
  }
  const hints = sanitizeHints(config.hints, warnings);
  return {
    configPath: SKILL_HINTS_RELATIVE_PATH,
    configured: true,
    roots: roots.map((root) => displaySkillPath(root, repo)),
    scannedSkills: dedupeSkills(scannedSkills).slice(0, MAX_SKILLS),
    hints,
    warnings
  };
}

export function applicableSkillHints(summary: SkillHintsSummary, paths: string[]): ApplicableSkillHint[] {
  if (!summary.configured || summary.hints.length === 0 || paths.length === 0) {
    return [];
  }
  const skillsByName = new Map(summary.scannedSkills.map((skill) => [skill.name, skill]));
  const selected: ApplicableSkillHint[] = [];
  const seen = new Set<string>();
  const normalizedPaths = uniqueSorted(paths.map(normalizeCodexPath).filter(Boolean));
  for (const hint of summary.hints) {
    for (const glob of hint.globs) {
      const matcher = globMatcher(glob);
      const matchedPath = normalizedPaths.find((candidate) => matcher(candidate));
      if (!matchedPath) {
        continue;
      }
      for (const skillName of hint.skills) {
        const key = `${skillName}\0${glob}\0${matchedPath}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const skill = skillsByName.get(skillName);
        selected.push({
          name: skillName,
          matchedGlob: glob,
          matchedPath,
          description: skill?.description,
          skillPath: skill?.path
        });
      }
    }
  }
  return selected.slice(0, 24);
}

export async function targetPlaybookHints(repoRoot: string, index: CodexaIndex, paths: string[]): Promise<TargetPlaybookHint[]> {
  const normalizedTargets = new Set(paths.map(normalizeCodexPath).filter(Boolean));
  if (normalizedTargets.size === 0) {
    return [];
  }
  const playbooks: TargetPlaybookHint[] = [];
  for (const module of index.modules) {
    if (!module.files.some((filePath) => normalizedTargets.has(normalizeCodexPath(filePath)))) {
      continue;
    }
    const safeName = safeModuleName(module.name);
    const relativePath = `.codex/codebase/playbooks/${safeName}.md`;
    if (!(await exists(path.join(repoRoot, relativePath)))) {
      continue;
    }
    playbooks.push({
      module: module.name,
      uri: `codexa://repo/codebase/playbooks/${encodeURIComponent(`${safeName}.md`)}`,
      path: relativePath
    });
  }
  return playbooks.slice(0, 12);
}

export function renderSkillHintsResource(summary: SkillHintsSummary): string {
  const lines = ["# Codexa Skill Hints", ""];
  if (!summary.configured) {
    lines.push(
      summary.warnings.length > 0
        ? `${SKILL_HINTS_RELATIVE_PATH} is present but could not be used.`
        : `No ${SKILL_HINTS_RELATIVE_PATH} file is configured for this repository.`
    );
    if (summary.warnings.length > 0) {
      lines.push("", "## Warnings", ...summary.warnings.map((warning) => `- ${warning}`));
    }
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Config: ${summary.configPath}`);
  lines.push("");
  lines.push("## Skill Roots");
  lines.push(...(summary.roots.length > 0 ? summary.roots.map((root) => `- ${root}`) : ["- none"]));
  lines.push("");
  lines.push("## Scanned Skills");
  lines.push(...(summary.scannedSkills.length > 0 ? summary.scannedSkills.map((skill) => `- ${skill.name}${skill.description ? ` - ${skill.description}` : ""}`) : ["- none"]));
  lines.push("");
  lines.push("## Path Hints");
  lines.push(...(summary.hints.length > 0 ? summary.hints.map((hint) => `- ${hint.globs.join(", ")} -> ${hint.skills.join(", ")}`) : ["- none"]));
  if (summary.warnings.length > 0) {
    lines.push("", "## Warnings", ...summary.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

async function readSkillHintsConfig(configPath: string, warnings: string[]): Promise<SkillHintsConfigV1 | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`could not read ${SKILL_HINTS_RELATIVE_PATH}: ${errorMessage(error)}`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`${SKILL_HINTS_RELATIVE_PATH} is not valid JSON: ${errorMessage(error)}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    warnings.push(`${SKILL_HINTS_RELATIVE_PATH} does not match schemaVersion 1`);
    return undefined;
  }
  return parsed as SkillHintsConfigV1;
}

function resolveConfiguredRoot(rawRoot: unknown, repoRoot: string, allowedRoots: string[], warnings: string[]): string[] {
  const trimmed = sanitizeConfigText(rawRoot, 300);
  if (!trimmed) {
    return [];
  }
  const homeExpanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  const repoExpanded = homeExpanded.replace(/^<repo>(?=$|[\\/])/u, repoRoot);
  const candidate = path.isAbsolute(repoExpanded) ? repoExpanded : path.join(repoRoot, repoExpanded);
  const resolved = path.resolve(candidate);
  if (resolved.includes("\0")) {
    warnings.push(`ignored skill root with NUL byte`);
    return [];
  }
  if (!isAllowedSkillPath(resolved, allowedRoots)) {
    warnings.push(`ignored skill root outside allowed skill roots: ${displayConfiguredPath(trimmed, repoRoot)}`);
    return [];
  }
  return [resolved];
}

async function scanSkillRoot(root: string, repoRoot: string, allowedRoots: string[], warnings: string[]): Promise<ScannedSkillHint[]> {
  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch {
    warnings.push(`skill root unavailable: ${displaySkillPath(root, repoRoot)}`);
    return [];
  }
  if (!rootStat.isDirectory()) {
    warnings.push(`skill root is not a directory: ${displaySkillPath(root, repoRoot)}`);
    return [];
  }

  const directSkill = await readSkill(root, root, repoRoot, allowedRoots, warnings);
  if (directSkill) {
    return [directSkill];
  }

  let entries: string[];
  try {
    entries = (await fs.readdir(root)).sort().slice(0, MAX_ROOT_ENTRIES);
  } catch (error) {
    warnings.push(`could not list skill root ${displaySkillPath(root, repoRoot)}: ${errorMessage(error)}`);
    return [];
  }

  const skills: ScannedSkillHint[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const skill = await readSkill(path.join(root, entry), root, repoRoot, allowedRoots, warnings);
    if (skill) {
      skills.push(skill);
    }
  }
  return skills;
}

async function readSkill(skillDir: string, root: string, repoRoot: string, allowedRoots: string[], warnings: string[]): Promise<ScannedSkillHint | undefined> {
  const skillPath = path.join(skillDir, "SKILL.md");
  let realSkillPath: string;
  try {
    realSkillPath = await fs.realpath(skillPath);
  } catch {
    return undefined;
  }
  if (!isAllowedSkillPath(realSkillPath, allowedRoots)) {
    warnings.push(`ignored skill outside allowed roots: ${path.relative(root, skillPath) || path.basename(skillPath)}`);
    return undefined;
  }
  let stat;
  try {
    stat = await fs.stat(realSkillPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) {
    warnings.push(`ignored oversized or non-file skill: ${path.relative(root, skillPath) || path.basename(skillPath)}`);
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(realSkillPath, "utf8");
  } catch {
    return undefined;
  }
  const metadata = parseFrontmatter(raw);
  return {
    name: sanitizeSkillName(metadata.name) ?? path.basename(skillDir),
    root: displaySkillPath(root, repoRoot),
    path: displaySkillPath(realSkillPath, repoRoot),
    description: metadata.description ? limitText(metadata.description.replace(/\s+/gu, " "), 220) : undefined
  };
}

function allowedSkillRootPrefixes(repoRoot: string): string[] {
  return [path.resolve(repoRoot)];
}

function isAllowedSkillPath(candidate: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(candidate);
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith("---")) {
    return {};
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const metadata: { name?: string; description?: string } = {};
  for (const line of raw.slice(3, end).split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const value = match[2].trim().replace(/^['"]|['"]$/gu, "");
    if (match[1] === "name") {
      metadata.name = sanitizeSkillName(value);
    } else if (match[1] === "description") {
      metadata.description = sanitizeConfigText(value, 260);
    }
  }
  return metadata;
}

function sanitizeHints(rawHints: unknown, warnings: string[]): SkillHintsSummary["hints"] {
  const hints: SkillHintsSummary["hints"] = [];
  for (const hint of arrayConfig(rawHints, "hints", warnings).slice(0, MAX_HINTS)) {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
      warnings.push("ignored skill hint that is not an object");
      continue;
    }
    const record = hint as { glob?: unknown; globs?: unknown; skills?: unknown };
    const skills = uniqueSorted(arrayConfig(record.skills, "hint.skills", warnings).map(sanitizeSkillName).filter((value): value is string => Boolean(value))).slice(0, MAX_HINT_SKILLS);
    const extraGlobs = arrayConfig(record.globs, "hint.globs", warnings);
    const globs = uniqueSorted([record.glob, ...extraGlobs].map((glob) => sanitizeGlob(glob)).filter((value): value is string => Boolean(value))).slice(0, MAX_GLOBS_PER_HINT);
    if (skills.length === 0 || globs.length === 0) {
      warnings.push("ignored skill hint with no valid glob or skill");
      continue;
    }
    hints.push({ globs, skills });
  }
  return hints;
}

function arrayConfig(value: unknown, fieldName: string, warnings: string[]): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  warnings.push(`ignored ${fieldName} because it is not an array`);
  return [];
}

function sanitizeSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = value.trim();
  return /^[A-Za-z0-9_.:@/-]{1,80}$/u.test(sanitized) ? sanitized : undefined;
}

function sanitizeGlob(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = value.trim().replace(/\\/gu, "/");
  if (!sanitized || sanitized.length > 180 || sanitized.includes("\0") || sanitized.startsWith("/")) {
    return undefined;
  }
  return sanitized;
}

function sanitizeConfigText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return limitText(value.replace(/[\r\n\0]+/gu, " ").trim(), maxLength);
}

function dedupeSkills(skills: ScannedSkillHint[]): ScannedSkillHint[] {
  const seen = new Set<string>();
  const deduped: ScannedSkillHint[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    deduped.push(skill);
  }
  return deduped.sort((a, b) => a.name.localeCompare(b.name));
}

function globMatcher(glob: string): (candidate: string) => boolean {
  const normalized = normalizeCodexPath(glob);
  const pattern = globPatternToRegExpSource(normalized);
  const regex = new RegExp(`^${pattern}$`, "u");
  return (candidate: string) => regex.test(normalizeCodexPath(candidate));
}

function globPatternToRegExpSource(glob: string): string {
  let pattern = "";
  for (let index = 0; index < glob.length; ) {
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 2;
    } else if (glob[index] === "*") {
      pattern += "[^/]*";
      index += 1;
    } else {
      pattern += escapeRegExp(glob[index]);
      index += 1;
    }
  }
  return pattern;
}

function normalizeCodexPath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function safeModuleName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function displayConfiguredPath(rawPath: string, repoRoot: string): string {
  const homeExpanded = rawPath.startsWith("~/") ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  const repoExpanded = homeExpanded.replace(/^<repo>(?=$|[\\/])/u, repoRoot);
  return displaySkillPath(path.isAbsolute(repoExpanded) ? repoExpanded : path.join(repoRoot, repoExpanded), repoRoot);
}

function displaySkillPath(inputPath: string, repoRoot: string): string {
  const resolved = path.resolve(inputPath);
  const repo = path.resolve(repoRoot);
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    return `<repo>${toDisplaySuffix(path.relative(repo, resolved))}`;
  }
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    return `~${toDisplaySuffix(path.relative(home, resolved))}`;
  }
  const workspaceRoot = path.join(path.parse(repo).root, "srv");
  if (resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    return `<workspace>${toDisplaySuffix(path.relative(workspaceRoot, resolved))}`;
  }
  return `<absolute-path:${path.basename(resolved) || "root"}>`;
}

function toDisplaySuffix(relativePath: string): string {
  return relativePath ? `/${relativePath.split(path.sep).join("/")}` : "";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
