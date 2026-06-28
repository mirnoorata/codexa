import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { impactQuery } from "../src/query/impact.js";
import { symbolContextQuery } from "../src/query/inspection.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
describe("static-analysis scanner runners", () => {
it("imports SCIP JSON reports into derived symbol context and impact", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn start_server() {}\n", "utf8");
    await writeFile(path.join(repo, "src/main.rs"), "fn main() { crate::start_server(); }\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const startSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ start_server().";
    const mainSymbol = "scip-rust cargo fixture 0.1.0 src/main.rs/ main().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        metadata: { projectRoot: "/tmp/not-this-repo", toolInfo: { name: "fixture-scip", version: "1.0" } },
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol: startSymbol, symbolRoles: 1, singleLineRange: { line: 0, startCharacter: 7, endCharacter: 19 }, singleLineEnclosingRange: { line: 0, startCharacter: 0, endCharacter: 24 } }],
            symbols: [{ symbol: startSymbol, displayName: "start_server", kind: "Function" }]
          },
          {
            relativePath: "src/main.rs",
            language: "rust",
            occurrences: [
              { symbol: mainSymbol, symbolRoles: 1, singleLineRange: { line: 0, startCharacter: 3, endCharacter: 7 }, singleLineEnclosingRange: { line: 0, startCharacter: 0, endCharacter: 36 } },
              { symbol: startSymbol, symbolRoles: 0, range: [0, 18, 30] }
            ],
            symbols: [{ symbol: mainSymbol, displayName: "main", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.reports.some((report) => report.kind === "scip" && report.path.endsWith(".symbols.json"))).toBe(true);
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      tool: string;
      symbols: Array<{ qualifiedName: string; line?: number; confidence?: string }>;
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string; confidence?: string }>;
    };
    expect(converted.tool).toBe("scip:fixture-scip:1.0");
    expect(converted.symbols.find((symbol) => symbol.qualifiedName === startSymbol)?.line).toBe(1);
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: mainSymbol, toSymbol: startSymbol, confidence: "derived" }));

    const symbol = result.index?.symbols.find((candidate) => candidate.qualifiedName === startSymbol);
    expect(symbol?.source).toBe("static-analysis");
    expect(symbol?.confidence).toBe("derived");

    const context = await symbolContextQuery(repo, symbol!.id, { autoRefresh: false }, { depth: 1 });
    const contextData = context.data as { callers?: unknown[]; edgeEvidence?: Array<{ edgeKind: string; source: string; confidence: string }> };
    expect(contextData.callers?.length).toBeGreaterThan(0);
    expect(contextData.edgeEvidence?.some((edge) => edge.edgeKind === "REFERENCES" && edge.source === "static-analysis" && edge.confidence === "derived")).toBe(true);

    const impact = await impactQuery(repo, { symbol: symbol!.id }, { autoRefresh: false });
    const impactData = impact.data as { readFirstFiles?: string[]; edgeEvidence?: Array<{ edgeKind: string; source: string }> };
    expect(impactData.readFirstFiles).toContain("src/lib.rs");
    expect(impactData.readFirstFiles).toContain("src/main.rs");
    expect(impactData.edgeEvidence?.some((edge) => edge.edgeKind === "REFERENCES" && edge.source === "static-analysis")).toBe(true);
  });

it("maps SCIP symbol relationships without inventing path-only symbol callers", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-relationships-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/api.rs"), "trait Service {}\n", "utf8");
    await writeFile(path.join(repo, "src/impl.rs"), "struct Worker {}\nimpl Service for Worker {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const serviceSymbol = "scip-rust cargo fixture 0.1.0 src/api.rs/ Service#";
    const workerSymbol = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Worker#";
    const orphanSymbol = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Orphan#";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        metadata: { toolInfo: { name: "fixture-scip" } },
        documents: [
          {
            relativePath: "src/api.rs",
            language: "rust",
            occurrences: [{ symbol: serviceSymbol, symbolRoles: 1, range: [0, 6, 13], enclosingRange: [0, 0, 0, 16] }],
            symbols: [{ symbol: serviceSymbol, displayName: "Service", kind: "Trait" }]
          },
          {
            relativePath: "src/impl.rs",
            language: "rust",
            occurrences: [
              { symbol: workerSymbol, symbolRoles: 1, range: [0, 7, 13], enclosingRange: [0, 0, 0, 16] },
              { symbol: orphanSymbol, symbolRoles: 1, range: [1, 0, 6] },
              { symbol: serviceSymbol, symbolRoles: 0, range: [1, 5, 12] }
            ],
            symbols: [
              { symbol: workerSymbol, displayName: "Worker", kind: "Struct", relationships: [{ symbol: serviceSymbol, isImplementation: true }] },
              { symbol: orphanSymbol, displayName: "Orphan", kind: "Struct" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.index?.graphEdges.some((edge) => edge.edgeKind === "IMPLEMENTS" && edge.source === "static-analysis" && edge.confidence === "derived")).toBe(true);
    const service = result.index?.symbols.find((candidate) => candidate.qualifiedName === serviceSymbol);
    const context = await symbolContextQuery(repo, service!.id, { autoRefresh: false }, { depth: 1 });
    expect((context.data as { implementations?: unknown[] }).implementations?.length).toBeGreaterThan(0);

    const orphan = result.index?.symbols.find((candidate) => candidate.qualifiedName === orphanSymbol);
    const orphanContext = await symbolContextQuery(repo, orphan!.id, { autoRefresh: false }, { depth: 1 });
    expect((orphanContext.data as { callers?: unknown[] }).callers).toEqual([]);
  });

it("rejects non-numeric SCIP role values", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-role-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ used().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: "not-definition", range: [0, 7, 11] }],
            symbols: [{ symbol, displayName: "used", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true })).rejects.toThrow(/symbolRoles must be a non-negative integer bitset/);
  });

it("treats SCIP forward definitions as definitions rather than references", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-forward-definition-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn declared();\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ declared().";
    const scipPath = path.join(repo, "forward-definition.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 64, range: [0, 3, 11], enclosingRange: [0, 0, 0, 14] }],
            symbols: [{ symbol, displayName: "declared", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; line?: number }>;
      relationships?: Array<{ kind: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.symbols.find((candidate) => candidate.qualifiedName === symbol)?.line).toBe(1);
    expect(converted.relationships ?? []).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromPath: "src/lib.rs", toSymbol: symbol }));
  });

it("keeps SCIP relationships for the document-local side of duplicate definitions", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-duplicate-definitions-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "trait Shared {}\ntrait Target {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "trait Shared {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const shared = "scip-rust cargo fixture 0.1.0 Shared#";
    const target = "scip-rust cargo fixture 0.1.0 Target#";
    const scipPath = path.join(repo, "duplicate-definitions.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/a.rs",
            language: "rust",
            occurrences: [
              { symbol: shared, symbolRoles: 1, range: [0, 6, 12] },
              { symbol: target, symbolRoles: 1, range: [1, 6, 12] }
            ],
            symbols: [{ symbol: shared, displayName: "Shared", kind: "Trait", relationships: [{ symbol: target, isReference: true }] }, { symbol: target, displayName: "Target", kind: "Trait" }]
          },
          {
            relativePath: "src/b.rs",
            language: "rust",
            occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }],
            symbols: [{ symbol: shared, displayName: "Shared", kind: "Trait" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; path: string }>;
      relationships: Array<{ kind: string; fromSymbol?: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.symbols.filter((candidate) => candidate.qualifiedName === shared).map((candidate) => candidate.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: shared, fromPath: "src/a.rs", toSymbol: target }));
  });

it("keeps occurrence-derived duplicate SCIP definitions when symbol metadata is omitted", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-duplicate-fallback-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "trait Shared {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "trait Shared {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const shared = "scip-rust cargo fixture 0.1.0 Shared#";
    const scipPath = path.join(repo, "duplicate-fallback.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          { relativePath: "src/a.rs", language: "rust", occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }], symbols: [] },
          { relativePath: "src/b.rs", language: "rust", occurrences: [{ symbol: shared, symbolRoles: 1, range: [0, 6, 12] }], symbols: [] }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      symbols: Array<{ qualifiedName: string; path: string }>;
    };
    expect(converted.symbols.filter((candidate) => candidate.qualifiedName === shared).map((candidate) => candidate.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
  });

it("rejects malformed SCIP object range integers instead of defaulting them", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-object-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn target() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "object-range.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: { startLine: 0, startCharacter: -5, endCharacter: 3 } }],
            symbols: [{ symbol, displayName: "target", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/malformed range/);
  });

it("uses SCIP character ranges to assign same-line references to the nearest enclosing symbol", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-character-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn aaa(){target()} fn zzz(){target()} fn target(){}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const aaa = "scip-rust cargo fixture 0.1.0 src/lib.rs/ aaa().";
    const zzz = "scip-rust cargo fixture 0.1.0 src/lib.rs/ zzz().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "same-line.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: aaa, symbolRoles: 1, range: [0, 3, 6], enclosingRange: [0, 0, 0, 18] },
              { symbol: zzz, symbolRoles: 1, range: [0, 22, 25], enclosingRange: [0, 19, 0, 37] },
              { symbol: target, symbolRoles: 0, range: [0, 28, 34] },
              { symbol: target, symbolRoles: 1, range: [0, 42, 48] }
            ],
            symbols: [
              { symbol: aaa, displayName: "aaa", kind: "Function" },
              { symbol: zzz, displayName: "zzz", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: zzz, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: aaa, toSymbol: target }));
  });

it("sorts enclosing SCIP ranges by tuple specificity instead of scaled width", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-long-range-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn outer() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const outer = "scip-rust cargo fixture 0.1.0 src/lib.rs/ outer().";
    const inner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ inner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "long-range.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: outer, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 1, 0] },
              { symbol: inner, symbolRoles: 1, range: [0, 0, 1], enclosingRange: [0, 0, 0, 2_000_000] },
              { symbol: target, symbolRoles: 0, range: [0, 100, 101] },
              { symbol: target, symbolRoles: 1, range: [0, 13, 19] }
            ],
            symbols: [
              { symbol: outer, displayName: "outer", kind: "Function" },
              { symbol: inner, displayName: "inner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: inner, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: outer, toSymbol: target }));
  });

it("prefers the inner enclosing SCIP range when multiline ranges have equal line spans", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-equal-span-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn outer() {\n  target();\n}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const outer = "scip-rust cargo fixture 0.1.0 src/lib.rs/ outer().";
    const inner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ inner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "equal-span.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: outer, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 2, 10] },
              { symbol: inner, symbolRoles: 1, range: [0, 13, 18], enclosingRange: [0, 5, 2, 8] },
              { symbol: target, symbolRoles: 0, range: [1, 2, 8] },
              { symbol: target, symbolRoles: 1, range: [1, 2, 8] }
            ],
            symbols: [
              { symbol: outer, displayName: "outer", kind: "Function" },
              { symbol: inner, displayName: "inner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: inner, toSymbol: target }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: outer, toSymbol: target }));
  });

it("keeps recursive SCIP references as symbol-to-symbol relationships", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-recursive-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "fn recur(){recur()}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const recur = "scip-rust cargo fixture 0.1.0 src/lib.rs/ recur().";
    const scipPath = path.join(repo, "recursive.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: recur, symbolRoles: 1, range: [0, 3, 8], enclosingRange: [0, 0, 0, 19] },
              { symbol: recur, symbolRoles: 0, range: [0, 11, 16] }
            ],
            symbols: [{ symbol: recur, displayName: "recur", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; fromPath?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: recur, toSymbol: recur }));
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromPath: "src/lib.rs", toSymbol: recur, fromSymbol: undefined }));
  });

it("does not map SCIP definition-navigation relationships to caller references", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-navigation-flags-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/api.rs"), "trait Service {}\n", "utf8");
    await writeFile(path.join(repo, "src/impl.rs"), "struct Worker {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const service = "scip-rust cargo fixture 0.1.0 src/api.rs/ Service#";
    const worker = "scip-rust cargo fixture 0.1.0 src/impl.rs/ Worker#";
    const scipPath = path.join(repo, "navigation-flags.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/api.rs",
            language: "rust",
            occurrences: [{ symbol: service, symbolRoles: 1, range: [0, 6, 13] }],
            symbols: [{ symbol: service, displayName: "Service", kind: "Trait" }]
          },
          {
            relativePath: "src/impl.rs",
            language: "rust",
            occurrences: [{ symbol: worker, symbolRoles: 1, range: [0, 7, 13] }],
            symbols: [{ symbol: worker, displayName: "Worker", kind: "Struct", relationships: [{ symbol: service, isDefinition: true }, { symbol: service, isTypeDefinition: true }] }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false });
    const convertedReport = result.reports.find((report) => report.kind === "scip")!;
    const converted = JSON.parse(await readFile(path.join(repo, convertedReport.path), "utf8")) as {
      relationships: Array<{ kind: string; fromSymbol?: string; toSymbol?: string }>;
    };
    expect(converted.relationships).not.toContainEqual(expect.objectContaining({ kind: "REFERENCES", fromSymbol: worker, toSymbol: service }));
  });

it("rejects malformed, oversized, and unsafe SCIP JSON reports before import", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-invalid-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-outside-"));
    await writeFile(path.join(outside, "escape.rs"), "pub fn escape() {}\n", "utf8");
    await symlink(path.join(outside, "escape.rs"), path.join(repo, "src", "escape.rs"));

    const invalidJson = path.join(repo, "invalid.scip");
    await writeFile(invalidJson, "not-json", "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [invalidJson], index: false })).rejects.toThrow(/scip print --json/);

    const missingDocuments = path.join(repo, "missing-documents.scip.json");
    await writeFile(missingDocuments, JSON.stringify({ metadata: {} }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [missingDocuments], index: false })).rejects.toThrow(/documents array/);

    const unsafePath = path.join(repo, "unsafe.scip.json");
    await writeFile(unsafePath, JSON.stringify({ documents: [{ relativePath: "../escape.rs", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [unsafePath], index: false })).rejects.toThrow(/canonical relative path/);

    const whitespacePath = path.join(repo, "whitespace-path.scip.json");
    await writeFile(whitespacePath, JSON.stringify({ documents: [{ relativePath: " src/lib.rs ", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [whitespacePath], index: false })).rejects.toThrow(/canonical relative path/);

    const symlinkPath = path.join(repo, "symlink.scip.json");
    await writeFile(symlinkPath, JSON.stringify({ documents: [{ relativePath: "src/escape.rs", occurrences: [], symbols: [] }] }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [symlinkPath], index: false })).rejects.toThrow(/existing repository file|outside the repository/);

    const malformedRange = path.join(repo, "malformed-range.scip.json");
    await writeFile(
      malformedRange,
      JSON.stringify({ documents: [{ relativePath: "src/lib.rs", occurrences: [{ symbol: "scip-rust . lib().", symbolRoles: 1, range: [-1, 0, 1] }], symbols: [] }] }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [malformedRange], index: false })).rejects.toThrow(/malformed range/);

    const oversized = path.join(repo, "oversized.scip.json");
    await writeFile(oversized, " ".repeat(17 * 1024 * 1024), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [oversized], index: false })).rejects.toThrow(/exceeds/);

    const preserved = path.join(repo, "preserved.scip.json");
    await writeFile(
      preserved,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ preserved().", displayName: "preserved", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const preservedImport = await updateStaticAnalysisReports(repo, { scipReports: [preserved], index: false });
    const preservedReport = preservedImport.reports.find((report) => report.kind === "scip")!;
    const preservedContent = await readFile(path.join(repo, preservedReport.path), "utf8");

    await writeFile(
      preserved,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: Array.from({ length: 3_000 }, (_, index) => ({
              symbol: `scip-rust cargo fixture 0.1.0 src/lib.rs/ ${"x".repeat(900)}${index}().`,
              displayName: `preserved${index}`,
              kind: "Function"
            }))
          }
        ]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [preserved], index: false })).rejects.toThrow(/Generated symbol report exceeds/);
    expect(await readFile(path.join(repo, preservedReport.path), "utf8")).toBe(preservedContent);

    const hugeSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ ";
    const tooLargeConverted = path.join(repo, "too-large-converted.scip.json");
    await writeFile(
      tooLargeConverted,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: Array.from({ length: 3_000 }, (_, index) => ({
              symbol: `${hugeSymbol}${"x".repeat(900)}${index}().`,
              displayName: `used${index}`,
              kind: "Function"
            }))
          }
        ]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { scipReports: [tooLargeConverted], index: false })).rejects.toThrow(/Generated symbol report exceeds/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("too-large-converted") || entry.endsWith(".tmp"))).toEqual([]);
  });

it("does not publish partial generated SCIP reports when a later source fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-batch-atomic-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn imported() {}\n", "utf8");

    const valid = path.join(repo, "valid-new.scip.json");
    await writeFile(
      valid,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ imported().", displayName: "imported", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const invalid = path.join(repo, "invalid-new.scip.json");
    await writeFile(invalid, JSON.stringify({ metadata: {} }), "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [valid, invalid], index: false })).rejects.toThrow(/documents array/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("valid-new") || entry.endsWith(".tmp"))).toEqual([]);
  });

it("rolls back generated SCIP reports when final publish fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-publish-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn first() {}\npub fn second() {}\n", "utf8");

    const first = path.join(repo, "first-publish.scip.json");
    const second = path.join(repo, "second-publish.scip.json");
    for (const [reportPath, name] of [
      [first, "first"],
      [second, "second"]
    ] as const) {
      await writeFile(
        reportPath,
        JSON.stringify({
          documents: [
            {
              relativePath: "src/lib.rs",
              language: "rust",
              occurrences: [],
              symbols: [{ symbol: `scip-rust cargo fixture 0.1.0 src/lib.rs/ ${name}().`, displayName: name, kind: "Function" }]
            }
          ]
        }),
        "utf8"
      );
    }

    const secondImport = await updateStaticAnalysisReports(repo, { scipReports: [second], index: false });
    const secondDestination = path.join(repo, secondImport.reports.find((report) => report.kind === "scip")!.path);
    await rm(secondDestination, { force: true });
    await mkdir(secondDestination, { recursive: true });

    await expect(updateStaticAnalysisReports(repo, { scipReports: [first, second], index: false })).rejects.toThrow(/destination is not a file/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("first-publish") || entry.endsWith(".tmp"))).toEqual([]);
  });

it("restores stale generated SCIP reports when final publish fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-publish-restores-stale-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn fresh() {}\n", "utf8");

    const fresh = path.join(repo, "fresh-publish.scip.json");
    await writeFile(
      fresh,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [],
            symbols: [{ symbol: "scip-rust cargo fixture 0.1.0 src/lib.rs/ fresh().", displayName: "fresh", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );
    const firstImport = await updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false });
    const freshDestination = path.join(repo, firstImport.reports.find((report) => report.kind === "scip")!.path);
    await rm(freshDestination, { force: true });
    await mkdir(freshDestination, { recursive: true });
    const staleReport = path.join(repo, ".codex/static-analysis/scip-old.symbols.json");
    await writeFile(staleReport, '{"schemaVersion":1,"tool":"old","language":"rust","symbols":[]}\n', "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false })).rejects.toThrow(/destination is not a file/);
    expect(await readFile(staleReport, "utf8")).toContain('"tool":"old"');
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
