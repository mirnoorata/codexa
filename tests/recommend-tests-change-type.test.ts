import { describe, expect, it } from "vitest";
import { narrowTestRecommendationsByChangeType, outcomeLearningRecommendations, recommendTests, uniqueTests } from "../src/query/tests.js";
import type { CodexaIndex } from "../src/types.js";

/**
 * Narrow unit coverage for `recommendTests` change-type filtering. The
 * broader indexer tests cover the build + query pipeline; this one
 * isolates the post-collection narrowing step so a regression in the
 * style-mode filter is caught immediately.
 */

function makeIndex(): CodexaIndex {
  // Minimal CodexaIndex fixture: just enough fields for recommendTests
  // to walk the paths/edges we care about. Any field the code path
  // doesn't touch is allowed to be a no-op placeholder.
  return {
    snapshot: { repoRoot: "/fake/repo" },
    files: [
      { path: "web/src/styles.css", test: false },
      { path: "web/src/App.tsx", test: false },
      { path: "web/src/App.frame.test.ts", test: true },
      { path: "myapi/store.py", test: false },
      { path: "tests/test_app.py", test: true }
    ],
    imports: [],
    testEdges: [
      // Python pytest "authoritatively" covers the python module.
      {
        path: "tests/test_app.py",
        targetPath: "myapi/store.py",
        reason: "imports myapi/store.py",
        confidence: "authoritative"
      },
      // TS vitest "authoritatively" covers App.tsx.
      {
        path: "web/src/App.frame.test.ts",
        targetPath: "web/src/App.tsx",
        reason: "imports web/src/App.tsx",
        confidence: "authoritative"
      }
    ]
  } as unknown as CodexaIndex;
}

describe("recommendTests change-type filter", () => {
  it("keeps both Python and TS authoritative tests when change-type is unknown", () => {
    const index = makeIndex();
    const result = recommendTests(index, ["myapi/store.py", "web/src/App.tsx"], "/fake/repo", "unknown");
    const paths = result.map((r) => r.path).sort();
    expect(paths).toContain("tests/test_app.py");
    expect(paths).toContain("web/src/App.frame.test.ts");
  });

  it("attaches target-scoped provenance to recommended tests", () => {
    const [test] = recommendTests(makeIndex(), ["myapi/store.py"], "/fake/repo", "behavior");
    expect(test.path).toBe("tests/test_app.py");
    expect(test.provenance?.sources).toContain("authoritative_test_edge");
    expect(test.provenance?.targetPaths).toContain("myapi/store.py");
    expect(test.provenance?.degraded).not.toBe(true);
  });

  it("deduplicates by preferring non-degraded provenance over stale snapshot evidence", () => {
    const merged = uniqueTests([
      {
        path: "tests/test_app.py",
        reason: "legacy broad snapshot",
        rank: 99,
        evidenceTier: "authoritative",
        provenance: {
          schemaVersion: 1,
          origin: "snapshot",
          sources: ["snapshot_legacy"],
          targetPaths: ["old/file.py"],
          evidence: ["legacy broad snapshot"],
          degraded: true,
          degradedReason: "legacy snapshot test lacks planned-test provenance"
        }
      },
      {
        path: "tests/test_app.py",
        reason: "current graph edge",
        rank: 5,
        evidenceTier: "authoritative",
        provenance: {
          schemaVersion: 1,
          origin: "current",
          sources: ["authoritative_test_edge"],
          targetPaths: ["myapi/store.py"],
          evidence: ["current graph edge"]
        }
      }
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].provenance?.degraded).not.toBe(true);
    expect(merged[0].provenance?.sources).toContain("authoritative_test_edge");
    expect(merged[0].provenance?.sources).not.toContain("snapshot_legacy");
    expect(merged[0].provenance?.targetPaths).not.toContain("old/file.py");
  });

  it("makes outcome history boosts visible in recommendation reasons and provenance", () => {
    const index = makeIndex();
    const testFile = (index.files as Array<{ path: string; rankReasons?: Record<string, number> }>).find((file) => file.path === "tests/test_app.py");
    testFile!.rankReasons = { outcomeHistory: 2 };
    const [test] = recommendTests(index, ["myapi/store.py"], "/fake/repo", "behavior");
    expect(test.reason).toContain("outcome history");
    expect(test.provenance?.sources).toContain("outcome_history");
    expect(test.rank).toBeGreaterThan(5);
  });

  it("surfaces outcome learning recommendations from outcome-history provenance", () => {
    const index = makeIndex();
    const testFile = (index.files as Array<{ path: string; rankReasons?: Record<string, number> }>).find((file) => file.path === "tests/test_app.py");
    testFile!.rankReasons = { outcomeHistory: 2 };

    const [test] = recommendTests(index, ["myapi/store.py"], "/fake/repo", "behavior");
    const learning = outcomeLearningRecommendations([test]);

    expect(learning).toHaveLength(1);
    expect(learning[0]).toMatchObject({
      path: "tests/test_app.py"
    });
    expect(learning[0].sources).toContain("outcome_history");
    expect(learning[0].targetPaths).toEqual(expect.arrayContaining(["myapi/store.py", "tests/test_app.py"]));
    expect(learning[0].evidence.join(" ")).toContain("outcome");
  });

  it("drops Python pytest recommendations on style edits when no Python was touched", () => {
    const index = makeIndex();
    // CSS-only edit: style change. test_app.py must be dropped because
    // myapi/store.py isn't in the dirty set — the authoritative edge
    // is correct but unreachable from a pure CSS diff.
    const result = recommendTests(index, ["web/src/styles.css"], "/fake/repo", "style");
    const paths = result.map((r) => r.path);
    expect(paths).not.toContain("tests/test_app.py");
  });

  it("drops TS vitest recommendations on style edits when only Python was touched", () => {
    const index = makeIndex();
    const result = recommendTests(index, ["myapi/store.py"], "/fake/repo", "style");
    const paths = result.map((r) => r.path);
    expect(paths).not.toContain("web/src/App.frame.test.ts");
  });

  it("keeps Python tests on style edits when Python source IS in the dirty set", () => {
    const index = makeIndex();
    // Mixed edit (CSS + Python) marked style: still narrow to what the
    // edit actually touches. Python is legitimately affected.
    const result = recommendTests(
      index,
      ["web/src/styles.css", "myapi/store.py"],
      "/fake/repo",
      "style"
    );
    const paths = result.map((r) => r.path);
    expect(paths).toContain("tests/test_app.py");
  });

  it("behavior change-type keeps cross-language authoritative tests (no narrowing)", () => {
    const index = makeIndex();
    // Behavior changes can cross language boundaries through dynamic
    // dispatch, codegen, or runtime protocols — do not silently drop.
    const result = recommendTests(index, ["web/src/App.tsx"], "/fake/repo", "behavior");
    const paths = result.map((r) => r.path);
    expect(paths).toContain("web/src/App.frame.test.ts");
    // Note: test_app.py would not appear here anyway since App.tsx has
    // no testEdge pointing at it, but the assertion above proves the
    // function did not regress on the TS side.
  });

  it("narrowTestRecommendationsByChangeType drops stale heuristic snapshot tests on style, keeps authoritative", () => {
    // Simulates the post-edit review case: a snapshot was saved WITHOUT
    // change-type, so it may carry a heuristic-tier cross-language
    // recommendation. The post-edit path re-applies narrowing to the
    // merged list. style+CSS-only edit should drop the heuristic Python
    // test but keep the authoritative TS test.
    const merged = [
      {
        path: "tests/test_guess.py",
        reason: "imports api package by name",
        rank: 1,
        evidenceTier: "heuristic" as const
      },
      {
        path: "web/src/App.frame.test.ts",
        reason: "imports App.tsx through affected path",
        rank: 4,
        evidenceTier: "authoritative" as const
      }
    ];
    const narrowed = narrowTestRecommendationsByChangeType(merged, ["web/src/styles.css"], "style");
    const paths = narrowed.map((r) => r.path);
    expect(paths).not.toContain("tests/test_guess.py");
    expect(paths).toContain("web/src/App.frame.test.ts");
  });

  it("narrowTestRecommendationsByChangeType is a no-op for change-type=unknown", () => {
    const merged = [
      {
        path: "tests/test_guess.py",
        reason: "heuristic match",
        rank: 1,
        evidenceTier: "heuristic" as const
      }
    ];
    const result = narrowTestRecommendationsByChangeType(merged, ["web/src/styles.css"], "unknown");
    expect(result.map((r) => r.path)).toContain("tests/test_guess.py");
  });

  it("style preserves authoritative tests reached through the IMPORT graph, not only direct edges", () => {
    // Scenario: CSS edit + App.tsx imports styles.css + App.frame.test.ts
    // imports App.tsx. The test is authoritative via transitive
    // importers, NOT via a direct testEdge → styles.css. It must still
    // survive style-narrowing because the graph proves coverage.
    const transitiveIndex: CodexaIndex = {
      snapshot: { repoRoot: "/fake/repo" },
      files: [
        { path: "web/src/styles.css", test: false },
        { path: "web/src/App.tsx", test: false },
        { path: "web/src/App.frame.test.ts", test: true }
      ],
      imports: [
        // App.tsx imports styles.css
        { path: "web/src/App.tsx", specifier: "./styles.css", resolvedPath: "web/src/styles.css" },
        // The test file imports App.tsx
        { path: "web/src/App.frame.test.ts", specifier: "./App", resolvedPath: "web/src/App.tsx" }
      ],
      testEdges: []
    } as unknown as CodexaIndex;
    const result = recommendTests(transitiveIndex, ["web/src/styles.css"], "/fake/repo", "style");
    const paths = result.map((r) => r.path);
    // The transitive importer path tags the test as authoritative via
    // "imports ... through affected path". That MUST be preserved under
    // style narrowing — the filter only touches heuristic/fallback tiers.
    expect(paths).toContain("web/src/App.frame.test.ts");
  });

  it("style preserves authoritative tests that DIRECTLY cover an edited non-code asset", () => {
    // A CSS file can have an authoritative TS test covering it via
    // component snapshots; a template can have an authoritative pytest
    // covering it via server-rendering tests. The narrow-by-language
    // filter must not drop those — they are the whole point of the
    // recommendation.
    const indexWithDirectCss: CodexaIndex = {
      snapshot: { repoRoot: "/fake/repo" },
      files: [
        { path: "web/src/styles.css", test: false },
        { path: "web/src/StylesSnapshot.test.ts", test: true },
        { path: "templates/page.html", test: false },
        { path: "tests/test_views.py", test: true }
      ],
      imports: [],
      testEdges: [
        {
          path: "web/src/StylesSnapshot.test.ts",
          targetPath: "web/src/styles.css",
          reason: "component snapshot covers styles.css",
          confidence: "authoritative"
        },
        {
          path: "tests/test_views.py",
          targetPath: "templates/page.html",
          reason: "server-rendering pytest covers page.html",
          confidence: "authoritative"
        }
      ]
    } as unknown as CodexaIndex;

    // CSS-only style edit: the TS snapshot test must be kept (directly
    // covers the edited file).
    const cssOnly = recommendTests(indexWithDirectCss, ["web/src/styles.css"], "/fake/repo", "style");
    const cssPaths = cssOnly.map((r) => r.path);
    expect(cssPaths).toContain("web/src/StylesSnapshot.test.ts");

    // Template-only style edit: the Python pytest must be kept (directly
    // covers the edited template file) even though the test is .py and
    // no .py file was edited.
    const htmlOnly = recommendTests(indexWithDirectCss, ["templates/page.html"], "/fake/repo", "style");
    const htmlPaths = htmlOnly.map((r) => r.path);
    expect(htmlPaths).toContain("tests/test_views.py");
  });
});
