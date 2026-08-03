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

  it("keeps legacy and runner-specific coverage provenance distinct during dedupe", () => {
    const base = coverage("reported");
    const deduped = dedupeCoverage([
      base,
      { ...base, testRunner: "vitest" },
      { ...base, testRunner: "cypress" }
    ]);

    expect(deduped).toHaveLength(3);
    expect(deduped.map((entry) => entry.testRunner)).toEqual([undefined, "vitest", "cypress"]);
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
    expect(compactVerificationCoverage({ ...coverage("reported"), testRunner: "cypress" })).toMatchObject({ testRunner: "cypress" });
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

  it("does not let non-Cypress JavaScript coverage satisfy a Cypress-only dependency check", () => {
    const check = {
      kind: "dependency" as const,
      target: "browser-spec: cypress/e2e/login.cy.ts",
      reason: "verify the Cypress browser behavior",
      evidenceTier: "derived" as const,
      confidence: "derived" as const,
      paths: ["cypress/e2e/login.cy.ts"]
    };
    const baseInput = {
      editPaths: ["cypress/e2e/login.cy.ts"],
      reviewTargets: ["cypress/e2e/login.cy.ts"],
      selectedFiles: [] as string[],
      workflows: [],
      affectedEdges: [],
      affectedTests: [],
      tests: [],
      ranTests: [] as string[]
    };

    expect(
      evaluateRequiredChecks([check], {
        ...baseInput,
        verificationCoverage: [{ ...coverage("reported"), testRunner: "vitest" }]
      })
    ).toMatchObject([{ status: "missing", trustTier: "none" }]);
    expect(
      evaluateRequiredChecks([check], {
        ...baseInput,
        verificationCoverage: [coverage("reported")]
      })
    ).toMatchObject([{ status: "missing", trustTier: "none" }]);
    expect(
      evaluateRequiredChecks([check], {
        ...baseInput,
        verificationCoverage: [{ ...coverage("reported"), testRunner: "playwright" }]
      })
    ).toMatchObject([{ status: "missing", trustTier: "none" }]);
    for (const testRunner of [undefined, "vitest", "jest", "playwright"] as const) {
      expect(
        evaluateRequiredChecks([check], {
          ...baseInput,
          verificationCoverage: [
            {
              ...coverage("reported"),
              targetPath: "cypress/e2e/login.cy.ts",
              ...(testRunner ? { testRunner } : {})
            }
          ]
        }),
        testRunner ?? "legacy coverage without runner provenance"
      ).toMatchObject([{ status: "missing", trustTier: "none" }]);
    }
    expect(
      evaluateRequiredChecks([check], {
        ...baseInput,
        verificationCoverage: [
          {
            ...coverage("reported"),
            command: "cypress run --spec cypress/e2e/login.cy.ts",
            targetPath: "cypress/e2e/login.cy.ts",
            testRunner: "cypress"
          }
        ]
      })
    ).toMatchObject([{ status: "covered", trustTier: "reported" }]);
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
