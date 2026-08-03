import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSearchMatcher, matchScore } from "../src/query/search.js";

describe("compiled query search matcher", () => {
  it.each([
    ["src/auth/session.ts", "src/auth/session.ts", 10],
    ["session", "src/session.ts", 9],
    ["session", "src/session-helper.ts", 6],
    ["sess", "src/session-helper.ts", 2],
    ["session", "src/mock/session-helper.ts", 0],
    ["mock session", "src/mock/session-helper.ts", 6],
    ["SESSION", "src/Session.ts", 9],
    ["", "src/session.ts", 0]
  ] as const)("scores %s against %s as %i", (query, value, expected) => {
    expect(matchScore(query, value)).toBe(expected);
    expect(createSearchMatcher(query)(value)).toBe(expected);
  });

  it("matches the frozen pre-compilation scorer across syntax and decoy cases", () => {
    const matrix = [
      ["", "src/session.ts"],
      ["   ", "src/session.ts"],
      ["SESSION", "src/Session.ts"],
      ["src/auth/session.ts", "src/auth/session.ts"],
      ["session", "src/session.ts"],
      ["session", "src/session-helper.ts"],
      ["session_helper", "src/session-helper.ts"],
      ["sess", "src/session-helper.ts"],
      ["session", "src/mock/session-helper.ts"],
      ["mock session", "src/mock/session-helper.ts"],
      ["fixture", "tests/fixture/auth.ts"],
      ["@scope/pkg.entry", "node_modules/@scope/pkg.entry/index.ts"]
    ] as const;
    for (const [query, value] of matrix) {
      expect(createSearchMatcher(query)(value), `${query} => ${value}`).toBe(frozenMatchScore(query, value));
    }
  });

  it("preserves scorer output after the bounded cache stops admitting values", () => {
    const values = [
      "src/session.ts",
      ...Array.from({ length: 5_000 }, (_, index) =>
        index % 100 === 0 ? `src/session-${index}.ts` : `src/feature-${index}.ts`
      ),
      "src/session.ts"
    ];
    const matcher = createSearchMatcher("session");
    expect(values.map(matcher)).toEqual(values.map((value) => frozenMatchScore("session", value)));
  });
});

function frozenMatchScore(query: string, value: string): number {
  const q = normalize(query);
  const v = normalize(value);
  if (!q || !v) return 0;
  const decoyPattern = /(?:^|\b|[._/-])(decoy|mock|old|backup|copy|fixture)(?:$|\b|[._/-])/;
  const compactDecoyPattern = /(decoy|mock|backup|fixture)/;
  const spacedQuery = q.replace(/[_-]/g, " ");
  const compactQuery = q.replace(/[^a-z0-9]+/g, "");
  const queryAllowsDecoy = decoyPattern.test(spacedQuery) || compactDecoyPattern.test(compactQuery);
  const spacedValue = v.replace(/[_-]/g, " ");
  const compactValue = v.replace(/[^a-z0-9]+/g, "");
  const decoyish = decoyPattern.test(spacedValue) || compactDecoyPattern.test(compactValue);
  const terms = [...new Set([q, ...frozenQueryTerms(query)])].sort((left, right) => left.localeCompare(right));
  const basenameStem = path.posix.basename(v).replace(/\.[^.]+$/, "");
  const valueTokens = new Set(v.split(/[^a-z0-9]+/).filter(Boolean));
  let best = 0;
  for (const term of terms) {
    if (!term) continue;
    if (v === term) best = Math.max(best, 10);
    else if (basenameStem === term) best = Math.max(best, 9);
    else if (valueTokens.has(term)) best = Math.max(best, 6);
    else if (v.includes(term)) best = Math.max(best, 2);
  }
  return decoyish && !queryAllowsDecoy && best < 9 ? 0 : best;
}

function frozenQueryTerms(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_./@-]+/)
    .map(normalize)
    .filter((term) => term.length >= 2)
    .flatMap((term) => {
      const pathParts = term.includes("/") || term.includes(".") || term.includes("@")
        ? term.split(/[./@-]+/).filter((part) => part.length >= 2)
        : [];
      return [term, ...pathParts];
    });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
