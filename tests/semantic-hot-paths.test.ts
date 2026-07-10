import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import type { CodexaIndex, ImportEdgeFact, UsageSiteFact } from "../src/types.js";

it("preserves deterministic semantic facts across high-fanout TypeScript merges and Python exports", async () => {
  const repo = await createSemanticFixture();
  try {
    const first = await buildIndex({ repoRoot: repo });
    const second = await buildIndex({ repoRoot: repo });

    const namedImports = first.imports.filter(
      (entry) => entry.path === "src/named-consumer.ts" && entry.importedName?.startsWith("value")
    );
    expect(namedImports).toHaveLength(180);
    expect(new Set(namedImports.map(importIdentity))).toHaveProperty("size", 180);
    expect(namedImports.every((entry) => entry.resolvedPath === "src/library.ts")).toBe(true);

    const reExportUsages = first.usageSites.filter(
      (entry) => entry.path === "src/reexports.ts" && entry.source === "typescript-compiler" && entry.name.startsWith("alias")
    );
    expect(reExportUsages).toHaveLength(180);
    expect(new Set(reExportUsages.map(usageIdentity))).toHaveProperty("size", 180);
    expect(reExportUsages.every((entry) => Boolean(entry.targetSymbolId))).toBe(true);

    const typeUsages = first.usageSites.filter(
      (entry) => entry.path === "src/type-consumer.ts" && entry.kind === "type_reference" && entry.name.startsWith("Type")
    );
    expect(typeUsages).toHaveLength(180);
    expect(typeUsages.every((entry) => Boolean(entry.targetSymbolId))).toBe(true);

    const pythonExports = first.symbols.filter(
      (symbol) => symbol.path === "pkg/impl.py" && symbol.name.startsWith("exported_value") && symbol.exported
    );
    expect(pythonExports).toHaveLength(180);

    expect(semanticSignature(second)).toEqual(semanticSignature(first));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function createSemanticFixture(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-semantic-hot-paths-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "pkg"), { recursive: true });
  const names = Array.from({ length: 180 }, (_, index) => `value${index}`);
  const typeNames = Array.from({ length: 180 }, (_, index) => `Type${index}`);
  const pythonNames = Array.from({ length: 180 }, (_, index) => `exported_value${index}`);
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "semantic-hot-paths" }, null, 2), "utf8");
  await writeFile(
    path.join(repo, "src/library.ts"),
    `${names.map((name, index) => `export function ${name}() { return ${index} }`).join("\n")}\n${typeNames.map((name) => `export interface ${name} { value: number }`).join("\n")}\n`,
    "utf8"
  );
  await writeFile(path.join(repo, "src/named-consumer.ts"), `import { ${names.join(", ")} } from "./library"\nexport const values = [${names.map((name) => `${name}()`).join(", ")}]\n`, "utf8");
  await writeFile(path.join(repo, "src/reexports.ts"), `export { ${names.map((name, index) => `${name} as alias${index}`).join(", ")} } from "./library"\n`, "utf8");
  await writeFile(path.join(repo, "src/type-consumer.ts"), `import type { ${typeNames.join(", ")} } from "./library"\nexport type AllTypes = [${typeNames.join(", ")}]\n`, "utf8");
  await writeFile(
    path.join(repo, "src/usage-consumer.ts"),
    `import * as library from "./library"\nexport const values = [${names.map((name) => `library.${name}()`).join(", ")}]\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, "pkg/impl.py"),
    pythonNames.map((name, index) => `def ${name}():\n    return ${index}`).join("\n\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repo, "pkg/__init__.py"),
    `from .impl import ${pythonNames.join(", ")}\n\n__all__ = [${pythonNames.map((name) => JSON.stringify(name)).join(", ")}]\n`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function semanticSignature(index: CodexaIndex): { imports: string[]; usages: string[]; symbols: string[] } {
  return {
    imports: index.imports.filter((entry) => entry.path.startsWith("src/") || entry.path.startsWith("pkg/")).map(stableFactIdentity).sort(),
    usages: index.usageSites.filter((entry) => entry.path.startsWith("src/") || entry.path.startsWith("pkg/")).map(stableFactIdentity).sort(),
    symbols: index.symbols.filter((entry) => entry.path.startsWith("src/") || entry.path.startsWith("pkg/")).map(stableFactIdentity).sort()
  };
}

function stableFactIdentity(entry: CodexaIndex["imports"][number] | CodexaIndex["usageSites"][number] | CodexaIndex["symbols"][number]): string {
  const { indexedAt: _indexedAt, snapshotId: _snapshotId, ...stable } = entry;
  return JSON.stringify(stable);
}

function importIdentity(entry: ImportEdgeFact): string {
  return JSON.stringify([entry.path, entry.specifier, entry.importedName ?? null, entry.localName ?? null, entry.reExport ?? false, entry.typeOnly ?? false, entry.resolvedPath ?? null]);
}

function usageIdentity(entry: UsageSiteFact): string {
  return JSON.stringify([entry.path, entry.name, entry.kind, entry.range?.startByte ?? null, entry.targetSymbolId ?? null, entry.confidence]);
}
