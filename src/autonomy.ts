import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexaAutonomyMode = "read-only" | "full-access";
export type CodexaAutonomySource = "env:CODEXA_AUTOVERIFY" | "env:CODEXA_AUTONOMY" | "user-repo-policy" | "user-default-policy" | "default";

export interface CodexaAutonomyStatus {
  mode: CodexaAutonomyMode;
  source: CodexaAutonomySource;
  configPath: string;
  repoRoot?: string;
}

interface AutonomyConfig {
  schemaVersion: 1;
  defaultMode?: CodexaAutonomyMode;
  repos?: Record<string, AutonomyRepoPolicy>;
}

interface AutonomyRepoPolicy {
  mode: CodexaAutonomyMode;
  trustedAt: string;
}

export function parseAutonomyMode(value: string): CodexaAutonomyMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "full" || normalized === "full-access" || normalized === "bypass") {
    return "full-access";
  }
  if (normalized === "read-only" || normalized === "readonly" || normalized === "off") {
    return "read-only";
  }
  throw new Error(`Invalid autonomy mode: ${value}. Use read-only or full-access.`);
}

export async function effectiveAutonomyMode(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<CodexaAutonomyStatus> {
  const configPath = autonomyConfigPath(env);
  const autoVerifyEnv = env.CODEXA_AUTOVERIFY?.trim().toLowerCase();
  if (autoVerifyEnv === "1" || autoVerifyEnv === "true") {
    return { mode: "full-access", source: "env:CODEXA_AUTOVERIFY", configPath, repoRoot: path.resolve(repoRoot) };
  }
  if (autoVerifyEnv === "0" || autoVerifyEnv === "false" || autoVerifyEnv === "off") {
    return { mode: "read-only", source: "env:CODEXA_AUTOVERIFY", configPath, repoRoot: path.resolve(repoRoot) };
  }
  const autonomyEnv = env.CODEXA_AUTONOMY;
  if (autonomyEnv) {
    return { mode: parseAutonomyMode(autonomyEnv), source: "env:CODEXA_AUTONOMY", configPath, repoRoot: path.resolve(repoRoot) };
  }

  const config = await readAutonomyConfig(configPath);
  const repoKey = await repoPolicyKey(repoRoot);
  const repoPolicy = config.repos?.[repoKey];
  if (repoPolicy) {
    return { mode: repoPolicy.mode, source: "user-repo-policy", configPath, repoRoot: repoKey };
  }
  if (config.defaultMode) {
    return { mode: config.defaultMode, source: "user-default-policy", configPath, repoRoot: repoKey };
  }
  return { mode: "read-only", source: "default", configPath, repoRoot: repoKey };
}

export async function defaultAutonomyMode(env: NodeJS.ProcessEnv = process.env): Promise<CodexaAutonomyStatus> {
  const configPath = autonomyConfigPath(env);
  const config = await readAutonomyConfig(configPath);
  if (config.defaultMode) {
    return { mode: config.defaultMode, source: "user-default-policy", configPath };
  }
  return { mode: "read-only", source: "default", configPath };
}

export async function setAutonomyMode(input: { repoRoot?: string; global?: boolean; mode: CodexaAutonomyMode; env?: NodeJS.ProcessEnv }): Promise<CodexaAutonomyStatus> {
  const env = input.env ?? process.env;
  const configPath = autonomyConfigPath(env);
  const config = await readAutonomyConfig(configPath);
  if (input.global || !input.repoRoot) {
    config.defaultMode = input.mode;
    await writeAutonomyConfig(configPath, config);
    return { mode: input.mode, source: "user-default-policy", configPath };
  } else {
    const repoKey = await repoPolicyKey(input.repoRoot);
    config.repos = config.repos ?? {};
    config.repos[repoKey] = {
      mode: input.mode,
      trustedAt: new Date().toISOString()
    };
  }
  await writeAutonomyConfig(configPath, config);
  return effectiveAutonomyMode(input.repoRoot, env);
}

function autonomyConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.CODEXA_HOME) {
    return path.join(path.resolve(env.CODEXA_HOME), "autonomy.json");
  }
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(configHome, "codexa", "autonomy.json");
}

async function repoPolicyKey(repoRoot: string): Promise<string> {
  const resolved = path.resolve(repoRoot);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function readAutonomyConfig(configPath: string): Promise<AutonomyConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<AutonomyConfig>;
    return {
      schemaVersion: 1,
      defaultMode: isAutonomyMode(parsed.defaultMode) ? parsed.defaultMode : undefined,
      repos: normalizeRepoPolicies(parsed.repos)
    };
  } catch {
    return { schemaVersion: 1 };
  }
}

async function writeAutonomyConfig(configPath: string, config: AutonomyConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, configPath);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
}

function normalizeRepoPolicies(value: unknown): Record<string, AutonomyRepoPolicy> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const repos: Record<string, AutonomyRepoPolicy> = {};
  for (const [repo, policy] of Object.entries(value as Record<string, unknown>)) {
    if (!policy || typeof policy !== "object") {
      continue;
    }
    const record = policy as Partial<AutonomyRepoPolicy>;
    if (isAutonomyMode(record.mode)) {
      repos[repo] = {
        mode: record.mode,
        trustedAt: typeof record.trustedAt === "string" ? record.trustedAt : ""
      };
    }
  }
  return Object.keys(repos).length > 0 ? repos : undefined;
}

function isAutonomyMode(value: unknown): value is CodexaAutonomyMode {
  return value === "read-only" || value === "full-access";
}
