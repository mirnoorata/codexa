import { describe, expect, it } from "vitest";
import { verificationRecipes } from "../src/query/impact.js";
import type { CodexaIndex } from "../src/types.js";

function recipeIndex(overrides: Partial<CodexaIndex>): CodexaIndex {
  return {
    files: [],
    symbols: [],
    usageSites: [],
    imports: [],
    risks: [],
    ...overrides
  } as unknown as CodexaIndex;
}

describe("verification recipes", () => {
  it("uses unittest guidance when the indexed Python tests import unittest", () => {
    const index = recipeIndex({
      files: [
        { path: "src/inventory/pricing.py", language: "python", test: false },
        { path: "tests/test_pricing.py", language: "python", test: true }
      ] as CodexaIndex["files"],
      imports: [{ path: "tests/test_pricing.py", specifier: "unittest" }] as CodexaIndex["imports"]
    });

    const recipes = verificationRecipes(index, ["src/inventory/pricing.py", "tests/test_pricing.py"], "behavior");

    expect(recipes).toContain(
      "Run the repository's unittest discovery suite (for example, `python -m unittest discover`) against the linked tests; use the documented project command when available."
    );
    expect(recipes.join("\n")).not.toContain("pytest");
  });

  it("prefers the scoped node:test package script in a monorepo", () => {
    const index = recipeIndex({
      files: [
        { path: "package.json", language: "json", test: false },
        { path: "package-lock.json", language: "json", test: false },
        { path: "packages/cart/src/cart.js", language: "javascript", test: false },
        { path: "packages/cart/test/cart.test.js", language: "javascript", test: true },
        { path: "packages/web/src/cart-summary.js", language: "javascript", test: false },
        { path: "packages/web/test/cart-summary.test.js", language: "javascript", test: true }
      ] as CodexaIndex["files"],
      usageSites: [
        { source: "manifest", path: "package.json", name: "npm script test", text: "node --test packages/*/test/*.test.js" },
        { source: "manifest", path: "package.json", name: "npm script test:cart", text: "node --test packages/cart/test/*.test.js" },
        { source: "manifest", path: "package.json", name: "npm script test:web", text: "node --test packages/web/test/*.test.js" }
      ] as CodexaIndex["usageSites"]
    });

    const recipes = verificationRecipes(index, ["packages/web/src/cart-summary.js", "packages/web/test/cart-summary.test.js"], "behavior");

    expect(recipes).toContain("Run the discovered node:test package test script: `npm run test:web`; read importers before API-shaped edits.");
    expect(recipes.join("\n")).not.toMatch(/Vitest|TypeScript/u);
  });

  it("uses a conservative JavaScript fallback when no runner is indexed", () => {
    const index = recipeIndex({
      files: [{ path: "src/widget.js", language: "javascript", test: false }] as CodexaIndex["files"]
    });

    const recipes = verificationRecipes(index, ["src/widget.js"], "behavior");

    expect(recipes).toContain(
      "Run the repository's documented JavaScript test command against the linked tests; inspect package scripts and read importers before API-shaped edits."
    );
    expect(recipes.join("\n")).not.toMatch(/Vitest|TypeScript/u);
  });

  it("keeps TypeScript compilation guidance alongside runner-aware tests", () => {
    const index = recipeIndex({
      files: [{ path: "src/widget.ts", language: "typescript", test: false }] as CodexaIndex["files"]
    });

    const recipes = verificationRecipes(index, ["src/widget.ts"], "behavior");

    expect(recipes).toContain("Run the repository's TypeScript check or build for touched TypeScript files in addition to its tests.");
    expect(recipes).toContain(
      "Run the repository's documented JavaScript test command against the linked tests; inspect package scripts and read importers before API-shaped edits."
    );
  });
});
