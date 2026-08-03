import { isCypressTestPath } from "../../language.js";
import type { VerificationCoverage } from "../../types.js";

export function verificationTestRunnerCoversPath(coverage: VerificationCoverage, testPath: string): boolean {
  return !isCypressTestPath(testPath) || coverage.testRunner === "cypress";
}
