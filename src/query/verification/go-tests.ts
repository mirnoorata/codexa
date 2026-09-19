import { existsSync } from "node:fs";
import path from "node:path";
import type { CodexaIndex } from "../../types.js";
// Reuse the existing bounded, stable, contained synchronous reader. No source
// execution or Go toolchain is needed to classify a reported command.
import { readSemanticCacheText as readContainedText } from "../../semantic-cache-files.js";
import { normalizeCwd, type CoverageAddInput } from "./command-scope.js";
import { stripQuotes } from "./shell.js";

export function goModuleRoot(repoRoot: string, directory: string): string | undefined {
  if (directory.startsWith("__outside_repo__:") || path.isAbsolute(directory) || directory.split("/").includes("..")) return undefined;
  let current = directory;
  for (let depth = 0; depth < 64; depth++) {
    const filename = path.join(repoRoot, current, "go.mod");
    if (existsSync(filename)) {
      try { return /^module\s+\S+/mu.test(readContainedText(repoRoot, filename, 64 * 1024)) ? current : undefined; }
      catch { return undefined; }
    }
    if (current === ".") return undefined;
    current = path.posix.dirname(current);
  }
  return undefined;
}

export function addGoTestCoverage(args: string[], cwd: string, command: string, ctx: {
  index: CodexaIndex; repoRoot: string; addCoverage: (coverage: CoverageAddInput) => void;
}): void {
  const unknown = (reason: string) => ctx.addCoverage({ kind: "unknown", command, source: reason, scope: cwd, details: args });
  if (/\b(?:GOFLAGS|GOWORK|GOOS|GOARCH|GO111MODULE|CGO_ENABLED)\s*=/u.test(command)) return unknown("Go environment changes have unsupported selection semantics");
  const selectors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = stripQuotes(args[i]);
    if (/^-(?:v|json|race|cover|failfast)(?:=(?:true|false))?$/u.test(arg)) continue;
    const name = arg.split("=", 1)[0];
    if (["-count", "-parallel", "-timeout", "-shuffle", "-vet"].includes(name)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : stripQuotes(args[++i] ?? "");
      const valid = name === "-timeout" ? /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/u.test(value)
        : name === "-shuffle" ? /^(?:on|off|\d+)$/u.test(value)
        : name === "-vet" ? /^(?:off|all)$/u.test(value)
        : /^[1-9]\d*$/u.test(value);
      if (!valid) return unknown(`Go test option ${name} has an invalid or non-running value`);
      continue;
    }
    if (arg.startsWith("-")) return unknown(`Go test option ${name} has unsupported selection semantics`);
    if (!(arg === "." || arg === "./..." || /^\.\/[\w./-]+$/u.test(arg)) || arg.split("/").includes("..") || arg.endsWith(".go")) return unknown("Go tests require explicit local package selectors");
    selectors.push(arg);
  }
  if (!selectors.length) selectors.push(".");
  const scopes: Array<{ directory: string; recursive: boolean; module: string }> = [];
  for (const selector of selectors) {
    const recursive = selector.endsWith("/...");
    const relative = recursive ? selector.slice(0, -4) : selector;
    if (relative.includes("...")) return unknown("Go package pattern is unsupported");
    const directory = normalizeCwd(path.posix.join(cwd, relative), ctx.repoRoot);
    const module = goModuleRoot(ctx.repoRoot, directory);
    if (!module) return unknown("Go package scope has no safely readable local module");
    scopes.push({ directory, recursive, module });
  }
  const targets: Array<{ target: string; scope: string }> = [];
  for (const file of ctx.index.files) {
    if (!file.path.endsWith("_test.go")) continue;
    const directory = path.posix.dirname(file.path);
    const scope = scopes.find(item => {
      const relative = path.posix.relative(item.directory, directory);
      if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) return false;
      if (relative && !item.recursive) return false;
      if (item.recursive && relative.split("/").some(part => part === "vendor" || part === "testdata" || /^[._]/u.test(part))) return false;
      return goModuleRoot(ctx.repoRoot, directory) === item.module;
    });
    if (!scope) continue;
    if (ctx.index.symbols.some(symbol => symbol.kind === "function" && symbol.name === "TestMain" && path.posix.dirname(symbol.path) === directory)) continue;
    // Platform/build-constrained files need an observed build selection. Do
    // not infer it from this process's OS or a successful package exit code.
    // Go recognizes _GOOS, _GOARCH, or _GOOS_GOARCH at the end of
    // the name before _test.go; words earlier in the name are ordinary text.
    if (/.+_(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris|wasip1|windows|386|amd64|arm|arm64|loong64|mips|mipsle|mips64|mips64le|ppc64|ppc64le|riscv64|s390x|wasm)_test\.go$/u.test(path.posix.basename(file.path))) continue;
    try {
      const contents = readContainedText(ctx.repoRoot, path.join(ctx.repoRoot, file.path), 256 * 1024);
      if (/^\s*\/\/\s*(?:go:build|\+build)\b/mu.test(contents)) continue;
      const tests = ctx.index.symbols.filter(symbol => symbol.path === file.path && symbol.kind === "function" && /^Test(?:[^a-z]|$)/u.test(symbol.name) && symbol.name !== "TestMain");
      if (!tests.length) continue;
    } catch { continue; }
    targets.push({ target: file.path, scope: scope.directory });
    if (targets.length > 256) return unknown("Go test selection exceeds the bounded target limit");
  }
  if (!targets.length) return unknown("Go test selection has no indexed unconstrained test functions");
  for (const { target, scope } of targets) ctx.addCoverage({ kind: "go-tests", testRunner: "go", command, source: "local Go package test selection; reported execution only", scope, targetPath: target, details: args });
}
