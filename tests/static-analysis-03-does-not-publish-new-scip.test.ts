import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { impactQuery } from "../src/query/impact.js";
import { symbolContextQuery } from "../src/query/inspection.js";
import { updateStaticAnalysisReports } from "../src/static-analysis.js";
describe("static-analysis scanner runners", () => {
it("does not publish new SCIP reports when stale generated pruning fails", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-prune-fails-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    const staleFile = path.join(repo, ".codex/static-analysis/scip-stale-file.symbols.json");
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, '{"schemaVersion":1,"tool":"stale","language":"rust","symbols":[]}\n', "utf8");
    await mkdir(path.join(repo, ".codex/static-analysis/scip-stale.symbols.json"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn fresh() {}\n", "utf8");

    const fresh = path.join(repo, "fresh-prune.scip.json");
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

    await expect(updateStaticAnalysisReports(repo, { scipReports: [fresh], index: false })).rejects.toThrow();
    expect(await readFile(staleFile, "utf8")).toContain('"tool":"stale"');
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.includes("fresh-prune") || entry.endsWith(".tmp"))).toEqual([]);
  });

it("caps occurrence-derived SCIP relationships before generated report write", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-relationship-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn owner() {}\npub fn target() {}\n", "utf8");

    const owner = "scip-rust cargo fixture 0.1.0 src/lib.rs/ owner().";
    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const scipPath = path.join(repo, "relationship-cap.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: owner, symbolRoles: 1, range: [0, 7, 12], enclosingRange: [0, 0, 2, 0] },
              { symbol: target, symbolRoles: 1, range: [1, 7, 13] },
              ...Array.from({ length: 50_001 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 7, 13] }))
            ],
            symbols: [
              { symbol: owner, displayName: "owner", kind: "Function" },
              { symbol: target, displayName: "target", kind: "Function" }
            ]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/more than 50000 relationships/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

it("caps SCIP enclosing range derivation cost before scanning a hostile cross product", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-range-check-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn target() {}\n", "utf8");

    const target = "scip-rust cargo fixture 0.1.0 src/lib.rs/ target().";
    const owners = Array.from({ length: 1_001 }, (_, index) => `scip-rust cargo fixture 0.1.0 src/lib.rs/ owner${index}().`);
    const scipPath = path.join(repo, "range-check-cap.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [
              { symbol: target, symbolRoles: 1, range: [0, 7, 13] },
              ...owners.map((symbol, index) => ({ symbol, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 0, 1 + index] })),
              ...Array.from({ length: 1_001 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 0, 1] }))
            ],
            symbols: [
              { symbol: target, displayName: "target", kind: "Function" },
              ...owners.map((symbol, index) => ({ symbol, displayName: `owner${index}`, kind: "Function" }))
            ]
          }
        ]
      }),
      "utf8"
    );

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/enclosing range checks/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

it("caps SCIP enclosing range derivation cost across documents", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-global-range-cap-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/a.rs"), "pub fn target_a() {}\n", "utf8");
    await writeFile(path.join(repo, "src/b.rs"), "pub fn target_b() {}\n", "utf8");

    const document = (name: string) => {
      const target = `scip-rust cargo fixture 0.1.0 src/${name}.rs/ target_${name}().`;
      const owners = Array.from({ length: 501 }, (_, index) => `scip-rust cargo fixture 0.1.0 src/${name}.rs/ owner${index}().`);
      return {
        relativePath: `src/${name}.rs`,
        language: "rust",
        occurrences: [
          { symbol: target, symbolRoles: 1, range: [0, 7, 15] },
          ...owners.map((symbol, index) => ({ symbol, symbolRoles: 1, range: [0, 0, 0], enclosingRange: [0, 0, 0, 1 + index] })),
          ...Array.from({ length: 1_000 }, () => ({ symbol: target, symbolRoles: 0, range: [1, 0, 1] }))
        ],
        symbols: [{ symbol: target, displayName: `target_${name}`, kind: "Function" }, ...owners.map((symbol, index) => ({ symbol, displayName: `owner${index}`, kind: "Function" }))]
      };
    };
    const scipPath = path.join(repo, "global-range-cap.scip.json");
    await writeFile(scipPath, JSON.stringify({ documents: [document("a"), document("b")] }), "utf8");

    await expect(updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: false })).rejects.toThrow(/enclosing range checks/);
    const generatedFiles = await readdir(path.join(repo, ".codex/static-analysis")).catch(() => []);
    expect(generatedFiles.filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".symbols.json"))).toEqual([]);
  });

it("prunes stale generated SCIP conversions when a new SCIP source is imported", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-prune-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn current() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const oldSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ old_symbol().";
    const newSymbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ new_symbol().";
    const oldScip = path.join(repo, "old.scip.json");
    const newScip = path.join(repo, "new.scip.json");
    const scipReport = (symbol: string) =>
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: symbol.includes("old") ? "old_symbol" : "new_symbol", kind: "Function" }]
          }
        ]
      });
    await writeFile(oldScip, scipReport(oldSymbol), "utf8");
    await writeFile(newScip, scipReport(newSymbol), "utf8");

    const first = await updateStaticAnalysisReports(repo, { scipReports: [oldScip], index: true });
    const firstGenerated = first.reports.find((report) => report.kind === "scip")!;
    await writeFile(path.join(repo, "bad.scip.json"), JSON.stringify({ metadata: {} }), "utf8");
    await expect(updateStaticAnalysisReports(repo, { scipReports: [path.join(repo, "bad.scip.json")], index: true })).rejects.toThrow(/documents array/);
    await expect(readFile(path.join(repo, firstGenerated.path), "utf8")).resolves.toContain(oldSymbol);

    const updated = await updateStaticAnalysisReports(repo, { scipReports: [newScip], index: true });
    const generated = (await readdir(path.join(repo, ".codex/static-analysis"))).filter((entry) => /^scip-.*\.symbols\.json$/u.test(entry));

    expect(generated).toHaveLength(1);
    expect(generated[0]).toContain("new.scip");
    expect(updated.index?.symbols.some((symbol) => symbol.qualifiedName === newSymbol)).toBe(true);
    expect(updated.index?.symbols.some((symbol) => symbol.qualifiedName === oldSymbol)).toBe(false);
  });

it("preserves user-managed scip-named symbol reports during SCIP pruning", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-preserve-thirdparty-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn current() {}\n", "utf8");
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const thirdPartyReport = path.join(repo, ".codex/static-analysis/scip-thirdparty.symbols.json");
    await writeFile(
      thirdPartyReport,
      JSON.stringify({
        schemaVersion: 1,
        tool: "scip-typescript",
        language: "rust",
        symbols: [{ id: "scip-thirdparty", name: "thirdparty", qualifiedName: "scip-thirdparty", kind: "function", path: "src/lib.rs", line: 1 }]
      }),
      "utf8"
    );

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ current().";
    const scipPath = path.join(repo, "current.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: "current", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    await expect(readFile(thirdPartyReport, "utf8")).resolves.toContain("scip-typescript");
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === "scip-thirdparty" && candidate.source === "static-analysis")).toBe(true);
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === symbol && candidate.source === "static-analysis")).toBe(true);
  });

it("does not let ambient symbol reports crowd out generated SCIP symbols", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-scip-crowd-out-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn indexed() {}\n", "utf8");
    for (let index = 0; index < 55; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `aaa-${String(index).padStart(2, "0")}.symbols.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "ambient-symbol-tool",
          language: "rust",
          symbols: [{ id: `ambient-${index}`, name: `ambient${index}`, qualifiedName: `ambient${index}`, kind: "function", path: "src/lib.rs", line: 1 }]
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbol = "scip-rust cargo fixture 0.1.0 src/lib.rs/ indexed().";
    const scipPath = path.join(repo, "index.scip.json");
    await writeFile(
      scipPath,
      JSON.stringify({
        documents: [
          {
            relativePath: "src/lib.rs",
            language: "rust",
            occurrences: [{ symbol, symbolRoles: 1, range: [0, 7, 14] }],
            symbols: [{ symbol, displayName: "indexed", kind: "Function" }]
          }
        ]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { scipReports: [scipPath], index: true });
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === symbol && candidate.source === "static-analysis")).toBe(true);
  });

it("does not let generated SCIP reports crowd out an explicitly imported symbol report", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-crowd-out-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, ".codex/static-analysis"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn imported() {}\n", "utf8");
    for (let index = 0; index < 50; index += 1) {
      await writeFile(
        path.join(repo, ".codex/static-analysis", `scip-ambient-${String(index).padStart(2, "0")}.symbols.json`),
        JSON.stringify({
          schemaVersion: 1,
          tool: "ambient-scip",
          language: "rust",
          symbols: [{ id: `ambient-${index}`, name: `ambient${index}`, qualifiedName: `ambient${index}`, kind: "function", path: "src/lib.rs", line: 1 }]
        }),
        "utf8"
      );
    }
    execFileSync("git", ["add", "src/lib.rs"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });

    const symbolReport = path.join(repo, "external-symbols.json");
    await writeFile(
      symbolReport,
      JSON.stringify({
        schemaVersion: 1,
        tool: "explicit-symbol-tool",
        language: "rust",
        symbols: [{ id: "imported", name: "importedExternal", qualifiedName: "external::imported", kind: "function", path: "src/lib.rs", line: 2 }]
      }),
      "utf8"
    );

    const result = await updateStaticAnalysisReports(repo, { symbolReports: [symbolReport], index: true });
    const importedReport = result.reports.find((report) => report.kind === "symbol-report")!;
    expect(result.index?.symbols.some((candidate) => candidate.qualifiedName === "external::imported" && candidate.source === "static-analysis")).toBe(true);
    expect(result.index?.freshness.externalSymbolReportHashes?.[importedReport.path]).toBeTruthy();
  });

it("rejects malformed symbol report relationships during strict import", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-static-analysis-symbol-invalid-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/lib.rs"), "pub fn used() {}\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const reportPath = path.join(repo, "bad-symbols.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        tool: "fixture-symbol-tool",
        language: "rust",
        symbols: [{ id: "used", name: "used", qualifiedName: "crate::used", kind: "function", path: "src/lib.rs", line: 1 }],
        relationships: [{ kind: "USES_WRONG_KIND", fromPath: "src/lib.rs", toPath: "src/lib.rs" }]
      }),
      "utf8"
    );
    await expect(updateStaticAnalysisReports(repo, { symbolReports: [reportPath], index: false })).rejects.toThrow(/relationships\[0\]\.kind is unsupported/);
  });
});
