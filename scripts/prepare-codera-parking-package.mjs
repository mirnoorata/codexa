#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const releaseRoot = path.join(repoRoot, ".local", "release", "codera");
const distSource = path.join(repoRoot, "dist");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));

await assertBuiltDist();
await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(releaseRoot, { recursive: true });
await copyDir(distSource, path.join(releaseRoot, "dist"));
await fs.writeFile(path.join(releaseRoot, "package.json"), `${JSON.stringify(coderaPackageJson(), null, 2)}\n`, "utf8");
await fs.writeFile(path.join(releaseRoot, "README.md"), coderaReadme(), "utf8");

console.log(`Prepared Codera parking package at ${path.relative(repoRoot, releaseRoot)}`);
console.log("Review it, then publish only from the intended npm account:");
console.log(`  npm pack ${path.relative(repoRoot, releaseRoot)} --dry-run`);
console.log(`  npm publish ${path.relative(repoRoot, releaseRoot)}`);

async function assertBuiltDist() {
  try {
    await fs.access(path.join(distSource, "cli.js"));
  } catch {
    throw new Error("dist/cli.js is missing. Run `npm run build` before preparing the Codera parking package.");
  }
}

function coderaPackageJson() {
  return {
    name: "codera",
    version: packageJson.version,
    description: "Public name reservation for the Codexa codebase intelligence MCP server.",
    license: packageJson.license,
    type: "module",
    bin: {
      codera: "./dist/cli.js",
      codexa: "./dist/cli.js"
    },
    files: ["dist", "README.md"],
    dependencies: packageJson.dependencies,
    engines: packageJson.engines
  };
}

function coderaReadme() {
  return `# Codera

Codera is the public name reserved for the Codexa codebase-intelligence MCP server.

This package currently ships the same working CLI and stdio MCP server as \`@mirnoorata/codexa\`, with both \`codera\` and \`codexa\` command aliases. It is intentionally functional rather than an empty placeholder.

## Usage

\`\`\`bash
npx -y codera serve <repo> --auto-refresh
codera init <repo>
\`\`\`

For the current Codex-focused package and docs, use \`@mirnoorata/codexa\`.
`;
}

async function copyDir(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}
