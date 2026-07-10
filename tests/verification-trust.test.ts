import { describe, expect, it } from "vitest";
import { compactVerificationCoverage, compactVerificationLedgerEntry, compactVerificationPlan } from "../src/mcp/compaction-helpers.js";
import { evaluateRequiredChecks } from "../src/query/required-checks.js";
import { verificationCommandPlan } from "../src/query/verification.js";
import { dedupeCoverage } from "../src/query/verification/command-scope.js";
import { strongerVerificationTrustTier, verificationTrustTierOrNone } from "../src/query/verification/trust.js";
import type { VerificationCoverage, VerificationTrustTier } from "../src/types.js";

describe("verification trust tiers", () => {
  it("keeps the strongest tier when duplicate coverage is merged in either order", () => {
    const reported = coverage("reported");
    const executed = coverage("executed-by-autoverify");

    for (const entries of [
      [reported, executed],
      [executed, reported]
    ]) {
      expect(dedupeCoverage(entries)).toMatchObject([{ trustTier: "executed-by-autoverify" }]);
      expect(verificationCommandPlan(entries)).toMatchObject([{ trustTier: "executed-by-autoverify" }]);
    }
  });

  it("treats missing or unknown persisted tiers as untrusted", () => {
    expect(verificationTrustTierOrNone(undefined)).toBe("none");
    expect(verificationTrustTierOrNone("executed-by-autoverify")).toBe("executed-by-autoverify");
    expect(verificationTrustTierOrNone("executed-by-user")).toBe("none");
    expect(strongerVerificationTrustTier("forged" as VerificationTrustTier, "none")).toBe("none");
    const legacyCoverage = { ...coverage("reported"), trustTier: undefined } as unknown as VerificationCoverage;
    expect(dedupeCoverage([legacyCoverage])).toMatchObject([{ trustTier: "none" }]);
    expect(verificationCommandPlan([legacyCoverage])).toMatchObject([{ trustTier: "none" }]);
    expect(compactVerificationCoverage({ trustTier: "forged" })).toMatchObject({ trustTier: "none" });
    expect(compactVerificationPlan({})).toMatchObject({ trustTier: "none" });
    expect(compactVerificationLedgerEntry({})).toMatchObject({ trustTier: "none" });
  });

  it("distinguishes command-backed dependency proof from structural evidence", () => {
    const check = {
      kind: "dependency" as const,
      target: "public-surface: src/value.ts",
      reason: "verify the changed public surface",
      evidenceTier: "derived" as const,
      confidence: "derived" as const,
      paths: ["src/value.ts", "tests/value.test.ts"]
    };
    const baseInput = {
      editPaths: ["src/value.ts"],
      reviewTargets: ["src/value.ts"],
      selectedFiles: [] as string[],
      workflows: [],
      affectedEdges: [],
      affectedTests: [],
      tests: [],
      ranTests: [] as string[],
      verificationCoverage: [] as VerificationCoverage[]
    };

    expect(evaluateRequiredChecks([check], { ...baseInput, selectedFiles: ["tests/value.test.ts"] })).toMatchObject([
      { status: "covered", trustTier: "none" }
    ]);
    expect(evaluateRequiredChecks([check], { ...baseInput, ranTests: ["tests/value.test.ts"] })).toMatchObject([
      { status: "covered", trustTier: "reported" }
    ]);
    expect(
      evaluateRequiredChecks([check], {
        ...baseInput,
        verificationCoverage: [{ ...coverage("executed-by-autoverify"), targetPath: "src/value.ts" }]
      })
    ).toMatchObject([{ status: "covered", trustTier: "executed-by-autoverify" }]);
  });
});

function coverage(trustTier: VerificationTrustTier): VerificationCoverage {
  return {
    kind: "javascript-tests",
    command: "npm test",
    source: "package script test",
    confidence: "authoritative",
    trustTier,
    scope: ".",
    details: [trustTier]
  };
}
