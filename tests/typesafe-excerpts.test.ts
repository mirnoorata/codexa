import { expect, it } from "vitest";
import { typeSafeSourceExcerpt } from "../src/typesafe-excerpts.js";

it("bounds oversized lines without splitting Unicode or inventing line coverage", () => {
  const source = "x".repeat(999) + "🎭" + "y".repeat(4000) + "\nexport const target = true;\n";
  const excerpt = typeSafeSourceExcerpt(source, "target", []);
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.windows.reduce((n, window) => n + window.text.length, 0)).toBeLessThanOrEqual(3000);
  for (const window of excerpt.windows) {
    expect(/[\uD800-\uDBFF]$/u.test(window.text)).toBe(false);
    expect(window.endLine - window.startLine + 1).toBe(window.text.split("\n").length);
  }
});

it("keeps small files complete and selects disjoint late evidence within the same budget", () => {
  expect(typeSafeSourceExcerpt("first\nsecond", "anything", []).truncated).toBe(false);
  const source = "// filler\n".repeat(500) + "export function rejectExpiredSession() { return false; }\n" + "// filler\n".repeat(500);
  const excerpt = typeSafeSourceExcerpt(source, "reject expired session", []);
  expect(excerpt.windows.some(window => window.startLine <= 501 && window.endLine >= 501 && window.text.includes("rejectExpiredSession"))).toBe(true);
  for (let i = 1; i < excerpt.windows.length; i++) expect(excerpt.windows[i].startLine).toBeGreaterThan(excerpt.windows[i - 1].endLine);
});
