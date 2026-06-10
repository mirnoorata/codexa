import { stableId } from "../util.js";

export const AUTO_VERIFY_POLICY_ID = "local-targeted-tests-v1";
export const AUTO_VERIFY_POLICY_DIGEST = stableId(
  AUTO_VERIFY_POLICY_ID,
  "hook-only",
  "minimal-env",
  "targeted-tests",
  "no-shell",
  "no-lifecycle-hooks",
  "source-mutation-non-covering"
);

const AUTO_VERIFY_TRUST_TOKEN = Symbol("codexa.autoverify.trusted-report");

export function autoVerifyPolicySignature(): string {
  return `${AUTO_VERIFY_POLICY_ID}:${AUTO_VERIFY_POLICY_DIGEST}`;
}

export function isTrustedAutoVerifyReport(report: unknown): boolean {
  return Boolean(report && typeof report === "object" && (report as { [AUTO_VERIFY_TRUST_TOKEN]?: unknown })[AUTO_VERIFY_TRUST_TOKEN] === true);
}

export function markTrustedAutoVerifyReport<T extends object>(report: T): T {
  Object.defineProperty(report, AUTO_VERIFY_TRUST_TOKEN, {
    value: true,
    enumerable: false
  });
  return report;
}
