import { describe, expect, it } from "vitest";
import { expandedQueryTerms } from "../src/retrieval.js";
import { tokenizeRetrievalText } from "../src/retrieval/helpers.js";
import { createRetrievalQueryMatcher, RETRIEVAL_QUERY_SCORE_CACHE_LIMIT } from "../src/retrieval/query-matcher.js";

describe("compiled retrieval query matcher", () => {
  it.each([
    ["auth", ["auth", "AUTH", "src/Auth.ts", "authentication", "src/session-manager.ts", "", "unrelated"]],
    ["fix session", ["fixSession", "src/fix-session.ts", "session fixture", "src/session.test.ts", "fixing a session"]],
    ["APIClient", ["apiClient", "src/api-client.ts", "API client adapter", "client"]],
    ["", ["", "src/auth.ts"]]
  ] as const)("preserves precompiled scores and matched terms for %s", (query, values) => {
    const terms = expandedQueryTerms(query);
    const matcher = createRetrievalQueryMatcher(query, terms);

    for (const value of values) {
      expect(matcher.score(value), value).toBe(legacyScore(query, value, terms));
    }

    const haystack = values.join(" ");
    expect(matcher.matchedTerms(haystack)).toEqual(legacyMatchedTerms(haystack, terms));
  });

  it("preserves scores after the bounded cache reaches capacity", () => {
    const query = "session";
    const terms = expandedQueryTerms(query);
    const matcher = createRetrievalQueryMatcher(query, terms);
    const admittedHotValue = "src/session.ts";

    expect(matcher.score(admittedHotValue)).toBe(legacyScore(query, admittedHotValue, terms));
    for (let index = 0; index < RETRIEVAL_QUERY_SCORE_CACHE_LIMIT + 1_000; index += 1) {
      const value = index % 97 === 0 ? `src/session-${index}.ts` : `src/feature-${index}.ts`;
      expect(matcher.score(value), value).toBe(legacyScore(query, value, terms));
    }
    expect(matcher.score(admittedHotValue)).toBe(legacyScore(query, admittedHotValue, terms));
  });
});

function legacyScore(query: string, value: string, terms: string[]): number {
  const queryText = normalizeForLegacyMatch(query);
  const valueText = normalizeForLegacyMatch(value);
  if (!queryText || !valueText) {
    return 0;
  }
  if (valueText === queryText) {
    return 14;
  }
  if (valueText.includes(queryText)) {
    return 10;
  }
  const valueTokens = new Set(tokenizeRetrievalText(value));
  const tokenHits = terms.filter((term) => valueTokens.has(term)).length;
  if (tokenHits > 0) {
    return Math.min(9, tokenHits * 2 + (tokenHits === terms.length ? 2 : 0));
  }
  const partialHits = terms.filter((term) => term.length >= 4 && valueText.includes(term)).length;
  return partialHits > 0 ? Math.min(6, partialHits * 1.5) : 0;
}

function legacyMatchedTerms(haystack: string, terms: string[]): string[] {
  const haystackTokens = new Set(tokenizeRetrievalText(haystack));
  return terms.filter((term) => haystackTokens.has(term));
}

function normalizeForLegacyMatch(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
