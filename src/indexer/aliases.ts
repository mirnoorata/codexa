import { promises as fs } from "node:fs";
import path from "node:path";
import { type ImportAliasRule } from "../resolver.js";
import { normalizePath } from "../util.js";

export async function loadImportAliases(repoRoot: string, files: string[]): Promise<ImportAliasRule[]> {
  const aliases: ImportAliasRule[] = [];
  const fileSet = new Set(files);
  for (const relativePath of files.filter((file) => path.posix.basename(file) === "tsconfig.json")) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const compilerOptions = parsed.compilerOptions ?? {};
      const paths = compilerOptions.paths ?? {};
      const configDir = path.posix.dirname(relativePath);
      const baseUrl = compilerOptions.baseUrl ?? ".";
      for (const [aliasPattern, targets] of Object.entries(paths)) {
        const target = targets[0];
        if (!target) {
          continue;
        }
        aliases.push(aliasRule(configDir, baseUrl, aliasPattern, target));
      }
    } catch {
      continue;
    }
  }
  for (const relativePath of files.filter((file) => path.posix.basename(file) === "package.json")) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as {
        name?: string;
        exports?: unknown;
        main?: string;
        module?: string;
        types?: string;
      };
      if (!parsed.name || typeof parsed.name !== "string") {
        continue;
      }
      const packageDir = path.posix.dirname(relativePath);
      for (const entry of packageExportTargets(parsed)) {
        const target = normalizePath(path.posix.join(packageDir === "." ? "" : packageDir, entry.target.replace(/^\.\//, "")));
        if (!targetExistsForAlias(target, fileSet)) {
          continue;
        }
        aliases.push({
          prefix: entry.subpath === "." ? parsed.name : `${parsed.name}/${entry.subpath.replace(/^\.\//, "")}`,
          targetPrefix: target,
          exact: true
        });
      }
    } catch {
      continue;
    }
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
}

function packageExportTargets(parsed: { exports?: unknown; main?: string; module?: string; types?: string }): Array<{ subpath: string; target: string }> {
  const result: Array<{ subpath: string; target: string }> = [];
  const add = (subpath: string, value: unknown) => {
    const target = exportTargetString(value);
    if (target) {
      result.push({ subpath, target });
    }
  };
  if (typeof parsed.exports === "string") {
    add(".", parsed.exports);
  } else if (parsed.exports && typeof parsed.exports === "object") {
    for (const [subpath, value] of Object.entries(parsed.exports as Record<string, unknown>)) {
      add(subpath, value);
    }
  }
  for (const fallback of [parsed.module, parsed.main, parsed.types, "./src/index.ts", "./src/index.tsx", "./index.ts"]) {
    add(".", fallback);
  }
  const seen = new Set<string>();
  return result.filter((entry) => {
    const key = `${entry.subpath}\0${entry.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function exportTargetString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["source", "types", "import", "module", "default", "require"]) {
    const target = exportTargetString(record[key]);
    if (target) {
      return target;
    }
  }
  return undefined;
}

function targetExistsForAlias(target: string, files: Set<string>): boolean {
  if (files.has(target)) {
    return true;
  }
  const ext = path.posix.extname(target);
  const stem = ext ? target.slice(0, -ext.length) : target;
  const variants = [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
    `${target}/index.js`
  ];
  return variants.some((variant) => files.has(variant));
}

function aliasRule(configDir: string, baseUrl: string, aliasPattern: string, targetPattern: string): ImportAliasRule {
  const wildcard = aliasPattern.endsWith("/*") && targetPattern.endsWith("/*");
  const aliasBase = wildcard ? aliasPattern.slice(0, -1) : aliasPattern;
  const targetBase = wildcard ? targetPattern.slice(0, -1) : targetPattern;
  return {
    prefix: aliasBase,
    targetPrefix: normalizeAliasTarget(configDir, baseUrl, targetBase),
    scopePrefix: configDir === "." ? undefined : configDir,
    exact: !wildcard
  };
}

function normalizeAliasTarget(configDir: string, baseUrl: string, targetPattern: string): string {
  return normalizePath(path.posix.normalize(path.posix.join(configDir === "." ? "" : configDir, baseUrl, targetPattern)));
}
