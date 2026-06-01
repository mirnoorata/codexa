#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const failures = [];

await requireIgnoredPaths(["node_modules/", "dist/", ".codex/codebase/", ".codex/cache/"]);
await requireThinQueriesBarrel();
await forbidSyncShellInQueryPath();
await forbidHeavyRuntimeDependencies();
await enforceSourceBoundaries();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`source-hygiene: ${failure}`);
  }
  process.exit(1);
}

async function requireIgnoredPaths(required) {
  const gitignore = await readText(".gitignore");
  for (const entry of required) {
    if (!gitignore.split(/\r?\n/u).includes(entry)) {
      failures.push(`.gitignore must include ${entry}`);
    }
  }
}

async function requireThinQueriesBarrel() {
  const text = await readText("src/queries.ts");
  const lines = text.trim().split(/\r?\n/u);
  if (lines.length > 80) {
    failures.push(`src/queries.ts must stay a thin barrel; found ${lines.length} lines`);
  }
  const nonExportLines = lines.filter((line) => line.trim() && !line.trim().startsWith("export "));
  if (nonExportLines.length > 0) {
    failures.push("src/queries.ts must contain only export lines");
  }
}

async function forbidSyncShellInQueryPath() {
  const files = [
    "src/queries.ts",
    ...(await listFiles("src/query", ".ts")),
    "src/mcp.ts",
    "src/command.ts",
    "src/repo-files.ts"
  ];
  const forbidden = /\b(execFileSync|spawnSync|execSync)\b/u;
  for (const file of files) {
    const text = await readText(file);
    if (forbidden.test(text)) {
      failures.push(`${file} must not use synchronous shell execution in MCP/query paths`);
    }
  }
}

async function forbidHeavyRuntimeDependencies() {
  const pkg = JSON.parse(await readText("package.json"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  const forbiddenRuntimeDependency = /^(?:kuzu(?:[-_].*)?|neo4j(?:[-_].*)?|@neo4j\/.+|semgrep(?:[-_].*)?|codeql(?:[-_].*)?)$/iu;
  for (const name of Object.keys(deps)) {
    if (forbiddenRuntimeDependency.test(name)) {
      failures.push(`runtime dependency ${name} violates Codexa's simple local architecture boundary`);
    }
  }
}

async function enforceSourceBoundaries() {
  const queryFiles = ["src/queries.ts", ...(await listFiles("src/query", ".ts"))];
  const indexerFiles = ["src/indexer.ts", ...(await listFiles("src/indexer", ".ts")), "src/repo-files.ts"];
  const evalFiles = ["src/eval.ts", ...(await listFiles("src/eval", ".ts"))];
  const mcpFiles = ["src/mcp.ts", ...(await listFiles("src/mcp", ".ts"))];
  const coreFiles = [...queryFiles, ...indexerFiles, ...evalFiles];
  await forbidImports(
    coreFiles,
    [
      { target: "src/mcp", label: "MCP adapter" },
      { target: "src/cli", label: "CLI adapter" },
      { target: "src/doctor", label: "doctor command adapter" },
      { target: "src/github-release", label: "GitHub release adapter" },
      { target: "src/init", label: "init command adapter" }
    ],
    "core query/index/eval code"
  );
  await forbidImports(
    queryFiles,
    [{ target: "src/eval", label: "eval harness" }],
    "query code"
  );
  await forbidImports(
    indexerFiles,
    [
      { target: "src/query", label: "query layer" },
      { target: "src/queries", label: "query barrel" },
      { target: "src/eval", label: "eval harness" }
    ],
    "indexer pipeline code"
  );
  await forbidImports(
    evalFiles,
    [
      { target: "src/mcp", label: "MCP adapter" },
      { target: "src/cli", label: "CLI adapter" },
      { target: "src/doctor", label: "doctor command adapter" },
      { target: "src/github-release", label: "GitHub release adapter" },
      { target: "src/init", label: "init command adapter" }
    ],
    "eval code"
  );
  await forbidImports(
    mcpFiles,
    [
      { target: "src/cli", label: "CLI adapter" },
      { target: "src/doctor", label: "doctor command adapter" },
      { target: "src/eval", label: "eval harness" },
      { target: "src/github-release", label: "GitHub release adapter" },
      { target: "src/init", label: "init command adapter" }
    ],
    "MCP adapter code"
  );
  await forbidImports(
    ["src/cli.ts", "src/doctor.ts", "src/github-release.ts"].filter(Boolean),
    [{ target: "src/mcp/tools", label: "executable MCP tool registration adapter" }],
    "CLI, doctor, and release tooling"
  );
  await forbidMcpToolRegistrationScanning();
}

async function forbidMcpToolRegistrationScanning() {
  const files = ["src/doctor.ts", "src/eval.ts", "src/cli.ts", "src/github-release.ts"];
  for (const file of files) {
    const text = await readText(file);
    if (hasMcpToolRegistrationCall(file, text)) {
      failures.push(`${file} must use the typed MCP tool registry instead of scanning registerTool calls`);
    }
  }
}

async function forbidImports(files, forbiddenTargets, ownerLabel) {
  for (const file of files) {
    const text = await readText(file);
    for (const specifier of importSpecifiers(file, text)) {
      const target = sourceImportTarget(file, specifier);
      if (!target) {
        continue;
      }
      const forbidden = forbiddenTargets.find((entry) => target === entry.target || target.startsWith(`${entry.target}/`));
      if (forbidden) {
        failures.push(`${file} imports ${specifier}; ${ownerLabel} must not depend on the ${forbidden.label}`);
      }
    }
  }
}

function importSpecifiers(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function hasMcpToolRegistrationCall(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "registerTool") {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "registerTool" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "server"
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceImportTarget(importer, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const withoutExtension = resolved.replace(/\.(?:c|m)?js$/u, "").replace(/\.ts$/u, "");
  return withoutExtension.endsWith("/index") ? withoutExtension.slice(0, -"/index".length) : withoutExtension;
}

async function listFiles(dir, suffix) {
  const absolute = path.join(repoRoot, dir);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(relative, suffix)));
    } else if (entry.isFile() && relative.endsWith(suffix)) {
      files.push(relative);
    }
  }
  return files.sort();
}

async function readText(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}
