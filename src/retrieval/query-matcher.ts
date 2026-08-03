import { tokenizeRetrievalText as tokenize } from "./helpers.js";

export interface RetrievalQueryMatcher {
  score(value: string): number;
  matchedTerms(haystack: string): string[];
}

export const RETRIEVAL_QUERY_SCORE_CACHE_LIMIT = 4_096;

export function createRetrievalQueryMatcher(query: string, terms: string[]): RetrievalQueryMatcher {
  const queryText = normalizeForMatch(query);
  const scoreCache = new Map<string, number>();
  const remember = (value: string, score: number): number => {
    if (scoreCache.size < RETRIEVAL_QUERY_SCORE_CACHE_LIMIT) {
      scoreCache.set(value, score);
    }
    return score;
  };
  return {
    score(value: string): number {
      const cached = scoreCache.get(value);
      if (cached !== undefined) {
        return cached;
      }
      const valueText = normalizeForMatch(value);
      if (!queryText || !valueText) {
        return remember(value, 0);
      }
      if (valueText === queryText) {
        return remember(value, 14);
      }
      if (valueText.includes(queryText)) {
        return remember(value, 10);
      }
      const valueTokens = new Set(tokenize(value));
      const tokenHits = terms.filter((term) => valueTokens.has(term)).length;
      if (tokenHits > 0) {
        const score = Math.min(9, tokenHits * 2 + (tokenHits === terms.length ? 2 : 0));
        return remember(value, score);
      }
      const partialHits = terms.filter((term) => term.length >= 4 && valueText.includes(term)).length;
      const score = partialHits > 0 ? Math.min(6, partialHits * 1.5) : 0;
      return remember(value, score);
    },
    matchedTerms(haystack: string): string[] {
      const haystackTokens = new Set(tokenize(haystack));
      return terms.filter((term) => haystackTokens.has(term));
    }
  };
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
