import path from "node:path";
import type { LanguageId } from "./types.js";

const GENERATED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".codex",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".vite",
  ".cache",
  ".pytest_cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".mypy_cache",
  ".ruff_cache"
]);

const GENERATED_SOURCE_SEGMENTS = new Set(["generated", "__generated__", "gen"]);

export function languageForPath(filePath: string): LanguageId {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") {
    return "typescript";
  }
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    return "javascript";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".rs") {
    return "rust";
  }
  if (ext === ".go") {
    return "go";
  }
  if (ext === ".java") {
    return "java";
  }
  if (ext === ".cs") {
    return "csharp";
  }
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(ext)) {
    return "cpp";
  }
  if (ext === ".c" || ext === ".h") {
    return "c";
  }
  if (ext === ".rb") {
    return "ruby";
  }
  if (ext === ".php") {
    return "php";
  }
  if (ext === ".json") {
    return "json";
  }
  if (ext === ".md" || ext === ".mdx" || ext === ".rst" || ext === ".txt") {
    return "markdown";
  }
  return "unknown";
}

export function isSourcePath(filePath: string): boolean {
  return (
    ["typescript", "javascript", "python", "json", "markdown"].includes(languageForPath(filePath)) ||
    /^scripts\/[^/]+\.sh$/.test(filePath) ||
    filePath.endsWith(".service")
  );
}

export function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) {
    return true;
  }
  return (
    filePath.endsWith(".min.js") ||
    filePath.endsWith(".map") ||
    filePath.endsWith(".lock") ||
    filePath.endsWith("package-lock.json") ||
    filePath.endsWith("pnpm-lock.yaml") ||
    filePath.endsWith("yarn.lock")
  );
}

export function isGeneratedPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const parts = normalized.split(/[\\/]/);
  return (
    parts.some((part) => GENERATED_SOURCE_SEGMENTS.has(part)) ||
    /(^|\/)[^/]+(\.generated|\.gen)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)[^/]+(_pb2|_pb2_grpc)\.py$/.test(normalized)
  );
}

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__)\//.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/.test(normalized) ||
    /(^|\/)[^/]+_test\.py$/.test(normalized) ||
    /(^|\/)[^/]+_test\.go$/.test(normalized)
  );
}

export function moduleNameForPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) {
    return "root";
  }
  if (parts[0] === "web" && parts.length > 2) {
    return `web/${parts[1]}`;
  }
  if (parts[0].endsWith("_api") && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "tests") {
    return "tests";
  }
  return parts[0];
}

export function isPublicSurfacePath(filePath: string): boolean {
  return (
    /(^|\/)(app|server|routes|api|router|main|index)\.[cm]?[jt]sx?$/.test(filePath) ||
    /(^|\/)(app|server|routes|api|main|__init__)\.py$/.test(filePath) ||
    filePath.includes("/adapters/") ||
    filePath.includes("/packages/") ||
    /^scripts\/(service|release|preview)-control\.sh$/.test(filePath) ||
    filePath.endsWith(".service")
  );
}
