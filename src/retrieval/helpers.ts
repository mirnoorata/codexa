import type { RetrievalLane, RetrievalMatch } from "../retrieval.js";
import { uniqueSorted } from "../util.js";
import { STOP_WORDS } from "./constants.js";

export function activeRetrievalLanes(lanes: RetrievalMatch["lanes"]): RetrievalLane[] {
  const order: RetrievalLane[] = ["exact", "symbol", "semantic", "bm25", "workflow", "test", "dirty", "graph"];
  return order.filter((lane) => (lanes[lane] ?? 0) > 0);
}

export function tokenizeRetrievalText(value: string): string[] {
  const expandedCamel = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return uniqueSorted(
    expandedCamel
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
  );
}

export function isDecoyLikePath(filePath: string): boolean {
  const spaced = filePath.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return /(?:^|\b|[._/-])(decoy|mock|old|backup|copy|fixture)(?:$|\b|[._/-])/u.test(spaced) || /(decoy|mock|backup|fixture)/u.test(spaced.replace(/[^a-z0-9]+/gu, ""));
}

export function queryAllowsDecoy(query: string): boolean {
  return /\b(decoy|mock|fixture|backup|old|copy)\b/iu.test(query);
}
