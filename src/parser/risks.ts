import { isPublicSurfacePath } from "../language.js";
import { detectPlaceholderRisks } from "../placeholder-signals.js";
import { CODE_PATTERN_RULES } from "../rules.js";
import type { ExtractContext } from "./context.js";
import { patternRiskFact, riskFact } from "./facts.js";

export function addCommonRisks(ctx: ExtractContext): void {
  if (isPublicSurfacePath(ctx.path)) {
    ctx.risks.push(riskFact(ctx, undefined, "public-surface", 2, "entrypoint, API, adapter, package, or index file"));
  }
  if (ctx.path.includes("/adapters/")) {
    ctx.risks.push(riskFact(ctx, undefined, "adapter-runtime", 2, "adapter runtime boundary"));
  }
  if (ctx.path.includes("/packages/")) {
    ctx.risks.push(riskFact(ctx, undefined, "package-manifest", 1.5, "package or node manifest"));
  }
  if (/^scripts\/(service|release|preview)-control\.sh$/.test(ctx.path) || ctx.path.endsWith(".service")) {
    ctx.risks.push(riskFact(ctx, undefined, "operator-runtime", 2, "service or release control surface"));
  }
  if (ctx.path.includes("migration") || ctx.path.includes("config") || ctx.path.endsWith(".service")) {
    ctx.risks.push(riskFact(ctx, undefined, "config-or-migration", 1.5, "configuration or migration-like path"));
  }
  if (ctx.test) {
    ctx.risks.push(riskFact(ctx, undefined, "test-file", 0.5, "test file"));
  }
}

export function addPatternRisks(ctx: ExtractContext): void {
  const seen = new Set<string>();
  for (const rule of CODE_PATTERN_RULES) {
    if (rule.languages && !rule.languages.includes(ctx.language)) {
      continue;
    }
    if (rule.path && !rule.path.test(ctx.path)) {
      continue;
    }
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let count = 0;
    for (const match of ctx.sourceText.matchAll(pattern)) {
      const start = match.index ?? 0;
      const key = `${rule.id}:${start}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      ctx.risks.push(patternRiskFact(ctx, rule.id, rule.score, rule.reason, start, start + match[0].length));
      count += 1;
      if (count >= 5) {
        break;
      }
    }
  }
}

export function addPlaceholderRisks(ctx: ExtractContext): void {
  ctx.risks.push(
    ...detectPlaceholderRisks({
      path: ctx.path,
      language: ctx.language,
      sourceText: ctx.sourceText,
      snapshotId: ctx.snapshotId,
      indexedAt: ctx.indexedAt,
      test: ctx.test
    })
  );
}
