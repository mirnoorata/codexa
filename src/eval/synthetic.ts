import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../indexer.js";
import { uniqueInOrder } from "./scoring.js";
import type { EvalScenario } from "./types.js";

export interface SyntheticRepo {
  repoRoot: string;
  ts: {
    helperPath: string;
    featurePath: string;
    testPath: string;
    decoyPath: string;
    helperSymbol: string;
  };
  python: {
    helperPath: string;
    appPath: string;
    testPath: string;
    decoyPath: string;
    helperSymbol: string;
  };
  manifest: {
    path: string;
    webReferencePath: string;
    decoyPath: string;
    typeId: string;
  };
  shared: {
    sharedPath: string;
    consumerPath: string;
    secondConsumerPath: string;
    testPath: string;
    leafPath: string;
    decoyPath: string;
    exportedSymbol: string;
    uniqueLiteral: string;
  };
}

export async function createSyntheticRepo(seed: string): Promise<SyntheticRepo> {
  const rng = seeded(seed);
  const token = alphaToken(rng, 8);
  const camel = `${token[0].toUpperCase()}${token.slice(1)}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `codexa-eval-${token}-`));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codexa Eval"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codexa-eval@example.invalid"], { cwd: repo, stdio: "ignore" });

  const tsHelper = `make${camel}Value`;
  const pyHelper = `normalize_${token}`;
  const typeId = `${token}.audio.speech_to_speech`;
  const sharedSymbol = `format${camel}Label`;
  const uniqueLiteral = `unique_${token}_literal`;
  const ts = {
    helperPath: `src/${token}_core.ts`,
    featurePath: `src/${token}_feature.ts`,
    testPath: `src/${token}_core.test.ts`,
    decoyPath: `src/${token}_core_decoy.ts`,
    helperSymbol: tsHelper
  };
  const python = {
    helperPath: `service_${token}/helpers.py`,
    appPath: `service_${token}/app.py`,
    testPath: `tests/test_${token}.py`,
    decoyPath: `service_${token}/helpers_decoy.py`,
    helperSymbol: pyHelper
  };
  const manifest = {
    path: `manifests/${token}.node.json`,
    webReferencePath: `web/src/${token}_node.ts`,
    decoyPath: `web/src/${token}_node_decoy.ts`,
    typeId
  };
  const shared = {
    sharedPath: `src/${token}_shared.ts`,
    consumerPath: `src/${token}_consumer_a.ts`,
    secondConsumerPath: `src/${token}_consumer_b.ts`,
    testPath: `src/${token}_shared.test.ts`,
    leafPath: `src/${token}_leaf.ts`,
    decoyPath: `src/${token}_shared_decoy.ts`,
    exportedSymbol: sharedSymbol,
    uniqueLiteral
  };

  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, `service_${token}`), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await mkdir(path.join(repo, "web/src"), { recursive: true });
  await mkdir(path.join(repo, "manifests"), { recursive: true });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc -p tsconfig.json --noEmit", test: "vitest run", check: "npm run typecheck && npm test" } }, null, 2), "utf8");
  await writeFile(path.join(repo, "pyproject.toml"), `[project]\ndependencies = ["pytest>=8"]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`, "utf8");
  await writeFile(path.join(repo, ts.helperPath), `export function ${tsHelper}() {\n  return "${token}"\n}\n`, "utf8");
  await writeFile(path.join(repo, ts.featurePath), `import { ${tsHelper} } from "./${token}_core"\nexport function use${camel}Feature() {\n  return ${tsHelper}()\n}\n`, "utf8");
  await writeFile(path.join(repo, ts.testPath), `import { ${tsHelper} } from "./${token}_core"\ntest("${token}", () => {\n  expect(${tsHelper}()).toBe("${token}")\n})\n`, "utf8");
  await writeFile(path.join(repo, ts.decoyPath), `export function ${tsHelper}Decoy() {\n  return "${token}-decoy"\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.sharedPath), `export function ${sharedSymbol}(value: string) {\n  return value.trim()\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.consumerPath), `import { ${sharedSymbol} } from "./${token}_shared"\nexport function render${camel}A(value: string) {\n  return ${sharedSymbol}(value)\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.secondConsumerPath), `import { ${sharedSymbol} } from "./${token}_shared"\nexport function render${camel}B(value: string) {\n  return ${sharedSymbol}(value).toUpperCase()\n}\n`, "utf8");
  await writeFile(path.join(repo, shared.testPath), `import { ${sharedSymbol} } from "./${token}_shared"\ntest("${token}-shared", () => {\n  expect(${sharedSymbol}(" A ")).toBe("A")\n})\n`, "utf8");
  await writeFile(path.join(repo, shared.leafPath), `export const ${token}LeafMarker = "${uniqueLiteral}"\n`, "utf8");
  await writeFile(path.join(repo, shared.decoyPath), `export function ${sharedSymbol}Decoy(value: string) {\n  return value\n}\n`, "utf8");
  await writeFile(path.join(repo, python.helperPath), `def ${pyHelper}(value):\n    return value.strip().lower()\n`, "utf8");
  await writeFile(
    path.join(repo, python.appPath),
    `from .helpers import ${pyHelper}\n\n@router.post("/${token}")\ndef route_${token}(value):\n    return ${pyHelper}(value)\n`,
    "utf8"
  );
  await writeFile(
    path.join(repo, python.testPath),
    `from service_${token}.app import route_${token}\n\ndef test_${token}_route():\n    assert route_${token}(" A ") == "a"\n`,
    "utf8"
  );
  await writeFile(path.join(repo, python.decoyPath), `def ${pyHelper}_decoy(value):\n    return value\n`, "utf8");
  await writeFile(
    path.join(repo, manifest.path),
    JSON.stringify({ nodes: [{ type_id: typeId, title: `${camel} Node`, adapter_key: `${token}.adapter` }] }, null, 2),
    "utf8"
  );
  await writeFile(path.join(repo, manifest.webReferencePath), `export const nodeType = "${typeId}"\n`, "utf8");
  await writeFile(path.join(repo, manifest.decoyPath), `export const nodeType = "${typeId}.decoy"\n`, "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "synthetic benchmark fixture"], { cwd: repo, stdio: "ignore" });
  await buildIndex({ repoRoot: repo, writeArtifacts: true });
  await writeFile(path.join(repo, python.helperPath), `def ${pyHelper}(value):\n    return value.strip().casefold()\n`, "utf8");

  return { repoRoot: repo, ts, python, manifest, shared };
}

function seeded(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 0xffffffff;
  };
}

function alphaToken(rng: () => number, length: number): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += letters[Math.floor(rng() * letters.length) % letters.length];
  }
  return value;
}

export async function cleanupScenarioRepos(scenarios: EvalScenario[]): Promise<void> {
  const roots = uniqueInOrder(scenarios.flatMap((scenario) => [...(scenario.cleanupRepoRoots ?? []), ...(scenario.cleanupRepoRoot ? [scenario.cleanupRepoRoot] : [])]));
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
}
