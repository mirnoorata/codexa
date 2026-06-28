import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/indexer.js";
import { postEditReviewWithTrustedRunnerReports } from "../src/query/post-edit.js";
import { CURRENT_VERIFICATION_PROVENANCE } from "../src/types.js";
import type { AutoVerifyCommandReport } from "../src/autoverify.js";
import { changePlanQuery, postEditReviewQuery } from "../src/queries.js";
import { createVerificationCoverageFixtureRepo } from "./indexer-fixtures.js";
describe("Codexa indexer", () => {
it("accounts for ranCommands through package-script coverage without over-covering tests", async () => {
    const repo = await createVerificationCoverageFixtureRepo();
    await buildIndex({ repoRoot: repo });

    await changePlanQuery(
      repo,
      {
        task: "Change shared behavior safely",
        files: ["src/shared.ts"],
        changeType: "behavior",
        diff: false,
        limit: 6,
        saveSnapshot: true,
        taskId: "verification-coverage"
      },
      { autoRefresh: false }
    );
    await writeFile(path.join(repo, "src/shared.ts"), "export function shared(value: string) { return value.trim().toUpperCase() }\n", "utf8");

    const typecheckOnly = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run typecheck"] }, { autoRefresh: true });
    const typecheckData = typecheckOnly.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
    };
    expect(typecheckData.verificationCoverage.map((entry) => entry.kind)).toContain("typescript-syntax");
    expect(typecheckData.verificationCoverage.map((entry) => entry.kind)).not.toContain("build");
    expect(typecheckData.testsNotRun.map((test) => test.path)).toEqual(expect.arrayContaining(["tests/shared.test.ts", "tests/other.test.ts"]));
    expect(typecheckData.verificationLedger.filter((entry) => entry.kind === "test").every((entry) => entry.status === "missing")).toBe(true);

    const buildOnly = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run build"] }, { autoRefresh: false });
    const buildOnlyData = buildOnly.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(buildOnlyData.testsNotRun.map((test) => test.path)).toEqual(expect.arrayContaining(["tests/shared.test.ts", "tests/other.test.ts"]));
    expect(buildOnlyData.verificationCoverage.map((entry) => entry.kind)).toContain("typescript-syntax");
    expect(buildOnlyData.verificationCoverage.map((entry) => entry.kind)).not.toContain("build");

    const targeted = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -- tests/shared.test.ts"] }, { autoRefresh: false });
    const targetedData = targeted.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
    };
    expect(targetedData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(targetedData.verificationLedger.find((entry) => entry.target === "tests/other.test.ts")?.status).toBe("missing");
    expect(targetedData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const directVitest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest run tests/shared.test.ts"] }, { autoRefresh: false });
    const directVitestData = directVitest.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(directVitestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(directVitestData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const directVitestAbsoluteTarget = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`vitest run ${path.join(repo, "tests/shared.test.ts")}`] }, { autoRefresh: false });
    const directVitestAbsoluteData = directVitestAbsoluteTarget.data as { verificationLedger: Array<{ target: string; status: string }> };
    expect(directVitestAbsoluteData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");

    const directVitestVersion = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest --version"] }, { autoRefresh: false });
    expect((directVitestVersion.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const directVitestHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["vitest -h"] }, { autoRefresh: false });
    expect((directVitestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const noEvidenceCommand = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["echo done"] }, { autoRefresh: false });
    const noEvidenceCommandData = noEvidenceCommand.data as { driftReasons: string[]; testsNotRun: Array<{ path: string }> };
    expect(noEvidenceCommandData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(noEvidenceCommandData.driftReasons).toContain("recommended tests have not been accounted for");
    expect(noEvidenceCommandData.driftReasons.some((reason) => reason.includes("remain unaccounted"))).toBe(false);

    const commandShapedRanTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranTests: ["npm run test -- tests/shared.test.ts"] }, { autoRefresh: false });
    const commandShapedRanTestData = commandShapedRanTest.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(commandShapedRanTestData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(commandShapedRanTestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("missing");

    const exactRanTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranTests: ["./tests/shared.test.ts"] }, { autoRefresh: false });
    const exactRanTestData = exactRanTest.data as {
      testsNotRun: Array<{ path: string }>;
      verificationLedger: Array<{ target: string; status: string; evidence: string[] }>;
    };
    expect(exactRanTestData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("covered");
    expect(exactRanTestData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const forwardedHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -- --help"] }, { autoRefresh: false });
    expect((forwardedHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmRunHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run test -h"] }, { autoRefresh: false });
    expect((npmRunHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmTestHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm test -h"] }, { autoRefresh: false });
    expect((npmTestHelp.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const npmBuildHelp = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run build -h"] }, { autoRefresh: false });
    const npmBuildHelpData = npmBuildHelp.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(npmBuildHelpData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(npmBuildHelpData.verificationCoverage.map((entry) => entry.kind)).not.toContain("typescript-syntax");

    const yarnRun = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["yarn run test"] }, { autoRefresh: false });
    expect((yarnRun.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const outsideRepo = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["cd /tmp && npm test"] }, { autoRefresh: false });
    expect((outsideRepo.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const waivedOne = await postEditReviewQuery(repo, { taskId: "verification-coverage", waivedChecks: ["tests/shared.test.ts"] }, { autoRefresh: false });
    const waivedOneData = waivedOne.data as { testsNotRun: Array<{ path: string }>; verificationLedger: Array<{ target: string; status: string }> };
    expect(waivedOneData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.status).toBe("waived");
    expect(waivedOneData.verificationLedger.find((entry) => entry.target === "tests/other.test.ts")?.status).toBe("missing");
    expect(waivedOneData.testsNotRun.map((test) => test.path)).toContain("tests/other.test.ts");

    const waivedAll = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        waivers: [
          { kind: "test", target: "tests/shared.test.ts", reason: "manual browser coverage for shared" },
          { kind: "test", target: "tests/other.test.ts", reason: "manual browser coverage for other" }
        ]
      },
      { autoRefresh: false }
    );
    const waivedAllData = waivedAll.data as { verdict: string; testsNotRun: unknown[]; verificationLedger: Array<{ target: string; waiverReason?: string }>; outcome: { calibrationLabels: string[]; waivers: unknown[] } };
    expect(waivedAllData.testsNotRun).toEqual([]);
    expect(waivedAllData.verdict).toBe("inspect");
    expect(waivedAllData.verificationLedger.find((entry) => entry.target === "tests/shared.test.ts")?.waiverReason).toBe("manual browser coverage for shared");
    expect(waivedAllData.outcome.waivers).toHaveLength(2);
    expect(waivedAllData.outcome.calibrationLabels).toContain("waived-behavior-test");

    const unrelatedWaiver = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranTests: [],
        ranCommands: [],
        waivers: [{ kind: "dependency", target: "unrelated dependency", reason: "not touched" }]
      },
      { autoRefresh: false }
    );
    const unrelatedWaiverData = unrelatedWaiver.data as { testsNotRun: Array<{ path: string }>; driftReasons: string[] };
    expect(unrelatedWaiverData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(unrelatedWaiverData.driftReasons).toContain("recommended tests have not been accounted for");

    const aggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run check"] }, { autoRefresh: false });
    const aggregateData = aggregate.data as {
      testsNotRun: unknown[];
      missedLikelyTests: unknown[];
      verificationCoverage: Array<{ kind: string; source: string; scope?: string }>;
      verificationLedger: Array<{ kind: string; target: string; status: string; evidence: string[] }>;
      outcome: { calibrationLabels: string[]; ranCommands: string[]; verificationLedger: unknown[] };
    };
    expect(aggregateData.testsNotRun).toEqual([]);
    expect(aggregateData.missedLikelyTests).toEqual([]);
    expect(aggregateData.verificationCoverage.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["typescript-syntax", "javascript-tests"]));
    expect(aggregateData.verificationLedger.some((entry) => entry.evidence.some((item) => item.includes("npm run check")))).toBe(true);
    expect(aggregateData.verificationLedger.filter((entry) => entry.kind === "test").every((entry) => entry.status === "covered")).toBe(true);
    expect(aggregateData.outcome.ranCommands).toEqual(["npm run check"]);
    expect(aggregateData.outcome.verificationLedger.length).toBeGreaterThan(0);
    expect(aggregateData.outcome.calibrationLabels).toContain("aggregate-command-coverage");
    expect(aggregateData.outcome.calibrationLabels).toContain("false-missing-test-warning-avoided");
    expect(aggregateData.outcome.calibrationLabels).not.toContain("missing-recommended-tests");

    const successfulReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 0, durationMs: 1234, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const successfulReportData = successfulReport.data as {
      testsNotRun: unknown[];
      ranCommandReports: Array<{ command: string; exitCode?: number; durationMs?: number }>;
      commandEnvelopes: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
      verificationProvenance: typeof CURRENT_VERIFICATION_PROVENANCE;
      verificationCoverage: Array<{ kind: string; exitCode?: number; durationMs?: number; outputSummary?: string; commandEnvelope?: { packageManager?: string; scriptName?: string } }>;
      outcome: {
        ranCommandReports: Array<{ command: string; cwd?: string; stdoutSummary?: string }>;
        commandEnvelopes: Array<{ command: string; cwd?: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; scopeStatus?: string; args: string[] }>;
        verificationProvenance: typeof CURRENT_VERIFICATION_PROVENANCE;
        calibrationLabels: string[];
      };
    };
    expect(successfulReportData.testsNotRun).toEqual([]);
    expect(successfulReportData.ranCommandReports[0]).toMatchObject({ command: "npm run check", exitCode: 0, durationMs: 1234 });
    expect(successfulReportData.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "derived-from-report", scopeStatus: "repo" });
    expect(successfulReportData.commandEnvelopes[0]).toMatchObject({ classifierVersion: CURRENT_VERIFICATION_PROVENANCE.commandCoverageClassifierVersion });
    expect(successfulReportData.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(successfulReportData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.exitCode === 0 && entry.outputSummary?.includes("vitest passed"))).toBe(true);
    expect(successfulReportData.verificationCoverage.some((entry) => entry.commandEnvelope?.packageManager === "npm" && entry.commandEnvelope.scriptName === "check")).toBe(true);
    expect(successfulReportData.outcome.ranCommandReports[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", stdoutSummary: "typecheck and vitest passed" });
    expect(successfulReportData.outcome.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "derived-from-report" });
    expect(successfulReportData.outcome.verificationProvenance).toEqual(CURRENT_VERIFICATION_PROVENANCE);
    expect(successfulReportData.outcome.calibrationLabels).toContain("aggregate-command-coverage");

    const secretArgReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm test -- --token s3cr3t-value --reporter /var/private-report.json",
            cwd: repo,
            exitCode: 0,
            args: ["--", "--token", "s3cr3t-value", "--reporter", "/var/private-report.json"],
            stdoutSummary: "Bearer s3cr3t-value"
          }
        ]
      },
      { autoRefresh: false }
    );
    const serializedSecretReport = JSON.stringify(secretArgReport.data);
    expect(serializedSecretReport).not.toContain("s3cr3t-value");
    expect(serializedSecretReport).not.toContain("/var/private-report.json");
    expect(serializedSecretReport).toContain("<redacted>");
    expect(serializedSecretReport).toContain("<abs-path>");

    const relativeSecretReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm test -- --reporter ../private-report.json --config ./secret.json",
            cwd: "../outside",
            exitCode: 0,
            args: ["--", "--reporter", "../private-report.json", "--config", "./secret.json"],
            stdoutSummary: "wrote ../private-report.json and ./secret.json"
          }
        ]
      },
      { autoRefresh: false }
    );
    const serializedRelativeReport = JSON.stringify(relativeSecretReport.data);
    expect(serializedRelativeReport).not.toContain("../outside");
    expect(serializedRelativeReport).not.toContain("../private-report.json");
    expect(serializedRelativeReport).not.toContain("./secret.json");
    expect(serializedRelativeReport).toContain("<outside-repo>");
    expect(serializedRelativeReport).toContain("<rel-path>");

    const persistedSanitizationReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranTests: [path.join(repo, "tests/shared.test.ts")],
        waivedChecks: [`manual check at ${path.join(repo, "private-check.log")}`],
        waivers: [{ kind: "test", target: path.join(repo, "tests/shared.test.ts"), reason: `manual run at ${path.join(repo, "private-report.log")}` }]
      },
      { autoRefresh: false }
    );
    const persistedSanitizationData = persistedSanitizationReport.data as { outcome: { path: string } };
    const persistedSanitization = await readFile(path.join(repo, persistedSanitizationData.outcome.path), "utf8");
    expect(persistedSanitization).not.toContain(repo);
    expect(persistedSanitization).toContain("<repo>");

    const reportedEnvelope = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm run check",
            cwd: repo,
            packageManager: "npm",
            packageRoot: ".",
            scriptName: "check",
            args: [],
            exitCode: 0,
            outputSummary: "structured wrapper passed"
          }
        ]
      },
      { autoRefresh: false }
    );
    const reportedEnvelopeData = reportedEnvelope.data as {
      testsNotRun: unknown[];
      commandEnvelopes: Array<{ command: string; packageManager?: string; packageRoot?: string; scriptName?: string; source?: string; args: string[] }>;
      verificationCoverage: Array<{ kind: string; source: string; outputSummary?: string; commandEnvelope?: { source?: string; scriptName?: string } }>;
      outcome: { commandEnvelopes: Array<{ command: string; cwd?: string; source?: string; scriptName?: string; outputSummary?: string }> };
    };
    expect(reportedEnvelopeData.testsNotRun).toEqual([]);
    expect(reportedEnvelopeData.commandEnvelopes[0]).toMatchObject({ command: "npm run check", packageManager: "npm", packageRoot: ".", scriptName: "check", source: "reported", args: [] });
    expect(reportedEnvelopeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.commandEnvelope?.source === "reported" && entry.outputSummary?.includes("structured wrapper passed"))).toBe(true);
    expect(reportedEnvelopeData.outcome.commandEnvelopes[0]).toMatchObject({ command: "npm run check", cwd: "<repo>", source: "reported", scriptName: "check", outputSummary: expect.stringContaining("structured wrapper passed") });

    const publicRunnerSpoof = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          {
            command: "npm run check",
            cwd: repo,
            exitCode: 0,
            stdoutSummary: "manual report passed",
            runner: {
              schemaVersion: 1,
              reportKind: "codexa-autoverify-report",
              runnerName: "codexa"
            } as never
          }
        ]
      },
      { autoRefresh: false }
    );
    const publicRunnerSpoofData = publicRunnerSpoof.data as {
      ranCommandReports: Array<{ runner?: unknown }>;
      autoVerifyRunnerEvidence: unknown[];
      outcome: { ranCommandReports: Array<{ runner?: unknown }> };
    };
    expect(publicRunnerSpoofData.ranCommandReports[0].runner).toBeUndefined();
    expect(publicRunnerSpoofData.outcome.ranCommandReports[0].runner).toBeUndefined();
    expect(publicRunnerSpoofData.autoVerifyRunnerEvidence).toEqual([]);

    const rejectedTrustedRunnerReport: AutoVerifyCommandReport = {
      command: "npm run check",
      cwd: repo,
      packageManager: "npm",
      packageRoot: ".",
      scriptName: "check",
      args: [],
      exitCode: 0,
      durationMs: 10,
      stdoutSummary: "claimed pass",
      runner: {
        schemaVersion: 1,
        reportKind: "codexa-autoverify-report",
        runnerName: "codexa",
        runnerVersion: "0.1.3",
        policyId: "local-targeted-tests-v1",
        policyDigest: "bad-policy-digest",
        taskId: "verification-coverage",
        snapshotDigest: "bad-snapshot",
        commandId: "bad-command",
        candidateDigest: "bad-candidate",
        headCommit: "bad-head",
        dirtyHashBefore: "bad-before",
        dirtyHashAfter: "bad-after",
        cwdRealpath: repo,
        targetRealpaths: [path.join(repo, "tests/shared.test.ts")],
        envMode: "minimal",
        allowedBy: ["unit-test fake"],
        sourceMutationDetected: false,
        timedOut: false,
        startedAt: "2026-05-31T00:00:00.000Z",
        finishedAt: "2026-05-31T00:00:00.001Z",
        outputRedacted: true,
        canonicalDigest: "bad-digest"
      }
    };
    const rejectedTrustedRunner = await postEditReviewWithTrustedRunnerReports(
      repo,
      { taskId: "verification-coverage" },
      [rejectedTrustedRunnerReport],
      { autoRefresh: false }
    );
    const rejectedTrustedRunnerData = rejectedTrustedRunner.data as {
      testsNotRun: Array<{ path: string }>;
      autoVerifyRunnerEvidence: Array<{ covering: boolean; reason: string }>;
      verificationCoverage: Array<{ kind: string }>;
    };
    expect(rejectedTrustedRunnerData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(rejectedTrustedRunnerData.autoVerifyRunnerEvidence[0]).toMatchObject({ covering: false });
    expect(rejectedTrustedRunnerData.autoVerifyRunnerEvidence[0].reason).toContain("missing internal AutoVerify trust marker");
    expect(rejectedTrustedRunnerData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const spoofedEnvelope = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "echo done", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0, stdoutSummary: "not actually tests" }]
      },
      { autoRefresh: false }
    );
    const spoofedEnvelopeData = spoofedEnvelope.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ source?: string; packageManager?: string; scriptName?: string }>;
    };
    expect(spoofedEnvelopeData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(spoofedEnvelopeData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "reported command envelope does not match command text" })]));
    expect(spoofedEnvelopeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(spoofedEnvelopeData.commandEnvelopes[0]).toMatchObject({ source: "reported", packageManager: "npm", scriptName: "test" });

    const missingCwdReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", exitCode: 0, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const missingCwdReportData = missingCwdReport.data as {
      driftReasons: string[];
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
    };
    expect(missingCwdReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingCwdReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));
    expect(missingCwdReportData.driftReasons).toContain("recommended tests have not been accounted for");

    const missingCwdReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", exitCode: 0, stdoutSummary: "typecheck and vitest passed" }]
      },
      { autoRefresh: false }
    );
    const missingCwdReportWithDuplicateRawData = missingCwdReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string }>;
    };
    expect(missingCwdReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingCwdReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));
    expect(missingCwdReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(missingCwdReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("missing-cwd");

    const outsideCwdReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: "/tmp/codexa-outside", exitCode: 0, stdoutSummary: "outside ok" }]
      },
      { autoRefresh: false }
    );
    const outsideCwdReportWithDuplicateRawData = outsideCwdReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string; packageRoot?: string }>;
    };
    expect(outsideCwdReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(outsideCwdReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(outsideCwdReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));
    expect(outsideCwdReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("outside-repo");

    const relativeEscapeReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: "../outside", exitCode: 0, stdoutSummary: "outside ok" }]
      },
      { autoRefresh: false }
    );
    const relativeEscapeReportWithDuplicateRawData = relativeEscapeReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      commandEnvelopes: Array<{ scopeStatus?: string; packageRoot?: string }>;
    };
    expect(relativeEscapeReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(relativeEscapeReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);
    expect(relativeEscapeReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown" })]));
    expect(relativeEscapeReportWithDuplicateRawData.commandEnvelopes[0]?.scopeStatus).toBe("outside-repo");

    const relativeCdEscape = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["cd .. && npm test"] }, { autoRefresh: false });
    const relativeCdEscapeData = relativeCdEscape.data as { testsNotRun: Array<{ path: string }>; verificationCoverage: Array<{ kind: string }> };
    expect(relativeCdEscapeData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(relativeCdEscapeData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const failedReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 1, durationMs: 321, stderrSummary: "vitest failed" }]
      },
      { autoRefresh: false }
    );
    const failedReportData = failedReport.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string; exitCode?: number; outputSummary?: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(failedReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(failedReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command failed with exit code 1", exitCode: 1 })]));
    expect(failedReportData.verificationCoverage.some((entry) => entry.outputSummary?.includes("vitest failed"))).toBe(true);
    expect(failedReportData.outcome.calibrationLabels).toContain("failed-verification-command");

    const failedReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm run check"],
        ranCommandReports: [{ command: "npm run check", cwd: repo, exitCode: 1, stderrSummary: "vitest failed" }]
      },
      { autoRefresh: false }
    );
    const failedReportWithDuplicateRawData = failedReportWithDuplicateRaw.data as {
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
    };
    expect(failedReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(failedReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command failed with exit code 1" })]));
    expect(failedReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const missingExitReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [{ command: "npm run check", cwd: repo }]
      },
      { autoRefresh: false }
    );
    const missingExitReportData = missingExitReport.data as {
      driftReasons: string[];
      testsNotRun: Array<{ path: string }>;
      verificationCoverage: Array<{ kind: string; source: string }>;
      outcome: { calibrationLabels: string[] };
    };
    expect(missingExitReportData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    expect(missingExitReportData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing exit code" })]));
    expect(missingExitReportData.driftReasons).toContain("recommended tests have not been accounted for");
    expect(missingExitReportData.outcome.calibrationLabels).not.toContain("aggregate-command-coverage");

    const missingExitReportWithDuplicateRaw = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", cwd: repo }]
      },
      { autoRefresh: false }
    );
      const missingExitReportWithDuplicateRawData = missingExitReportWithDuplicateRaw.data as {
        testsNotRun: Array<{ path: string }>;
        verificationCoverage: Array<{ kind: string; source: string }>;
        commandEnvelopes: Array<{ command: string; scopeStatus?: string }>;
      };
      expect(missingExitReportWithDuplicateRawData.testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
      expect(missingExitReportWithDuplicateRawData.commandEnvelopes).toEqual(
        expect.arrayContaining([expect.objectContaining({ command: "npm --silent test", scopeStatus: "repo" })])
      );
      expect(missingExitReportWithDuplicateRawData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing exit code" })]));
      expect(missingExitReportWithDuplicateRawData.verificationCoverage.some((entry) => entry.kind === "javascript-tests")).toBe(false);

    const duplicateCommandReports = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          { command: "npm run check", cwd: repo, exitCode: 0, stdoutSummary: "root ok" },
          { command: "npm run check", cwd: path.join(repo, "missing-package"), exitCode: 1, stderrSummary: "nested failed" }
        ]
      },
      { autoRefresh: false }
    );
    const duplicateCommandReportsData = duplicateCommandReports.data as {
      testsNotRun: unknown[];
      verificationCoverage: Array<{ kind: string; source: string; exitCode?: number; outputSummary?: string }>;
    };
    expect(duplicateCommandReportsData.testsNotRun).toEqual([]);
    expect(duplicateCommandReportsData.verificationCoverage.some((entry) => entry.kind === "javascript-tests" && entry.exitCode === 0 && entry.outputSummary?.includes("root ok"))).toBe(true);
    expect(duplicateCommandReportsData.verificationCoverage.some((entry) => entry.kind === "unknown" && entry.source === "command failed with exit code 1" && entry.outputSummary?.includes("nested failed"))).toBe(true);

    const distinctSameCommandReports = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommandReports: [
          { command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "first run" },
          { command: "npm test", cwd: repo, exitCode: 0, stdoutSummary: "second run" }
        ]
      },
      { autoRefresh: false }
    );
    const distinctSameCommandReportsData = distinctSameCommandReports.data as { commandEnvelopes: Array<{ stdoutSummary?: string }> };
    expect(distinctSameCommandReportsData.commandEnvelopes.map((entry) => entry.stdoutSummary)).toEqual(expect.arrayContaining(["first run", "second run"]));
    expect((distinctSameCommandReports.data as { verificationCoverage: Array<{ outputSummary?: string }> }).verificationCoverage.map((entry) => entry.outputSummary)).toEqual(
      expect.arrayContaining([expect.stringContaining("first run"), expect.stringContaining("second run")])
    );

    const rootCdAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`cd ${repo} && npm run check`] }, { autoRefresh: false });
    expect((rootCdAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const envAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["CI=1 npm run check"] }, { autoRefresh: false });
    expect((envAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const envCommandAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["env CI=1 NODE_ENV=test npm run check"] }, { autoRefresh: false });
    expect((envCommandAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const bashWrappedAggregate = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ['bash -lc "npm run check"'] }, { autoRefresh: false });
    expect((bashWrappedAggregate.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const silentNpmTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm --silent test"] }, { autoRefresh: false });
    expect((silentNpmTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const semanticDuplicateReport = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", cwd: repo, exitCode: 0, stdoutSummary: "structured silent" }]
      },
      { autoRefresh: false }
    );
    const semanticDuplicateReportData = semanticDuplicateReport.data as { testsNotRun: unknown[]; commandEnvelopes: Array<{ command: string; stdoutSummary?: string }> };
    expect(semanticDuplicateReportData.testsNotRun).toEqual([]);
    expect(semanticDuplicateReportData.commandEnvelopes).toEqual([expect.objectContaining({ command: "npm --silent test", stdoutSummary: "structured silent" })]);

    const malformedSemanticDuplicate = await postEditReviewQuery(
      repo,
      {
        taskId: "verification-coverage",
        ranCommands: ["npm test"],
        ranCommandReports: [{ command: "npm --silent test", exitCode: 0, stdoutSummary: "missing cwd" }]
      },
      { autoRefresh: false }
    );
      const malformedSemanticDuplicateData = malformedSemanticDuplicate.data as {
        testsNotRun: unknown[];
        commandEnvelopes: Array<{ command: string; scopeStatus?: string }>;
        verificationCoverage: Array<{ kind: string; source: string }>;
      };
      expect(malformedSemanticDuplicateData.testsNotRun).not.toEqual([]);
      expect(malformedSemanticDuplicateData.commandEnvelopes).toEqual(expect.arrayContaining([expect.objectContaining({ command: "npm --silent test", scopeStatus: "missing-cwd" })]));
      expect(malformedSemanticDuplicateData.verificationCoverage).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown", source: "command report missing cwd" })]));

    const shortSilentNpmTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm -s test"] }, { autoRefresh: false });
    expect((shortSilentNpmTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const fallbackShellFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["false || npm test"] }, { autoRefresh: false });
    expect((fallbackShellFlow.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // A pipe without pipefail returns the last stage's (tee's) exit, masking a
    // test failure, so a piped runner must NOT count as covering (fail-closed).
    const pipedTestOutput = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm test | tee /tmp/codexa-test.log"] }, { autoRefresh: false });
    expect((pipedTestOutput.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    // A trailing `|| true` / `;` / `&` (background) masks a test failure (the
    // aggregate exit code is forced/decoupled), so it must NOT count as covering
    // — even when hidden inside a shell wrapper or a package-script body.
    const maskCases = ["npm test || true", "npm test ; echo ok", "npm test &", "npm test & echo bg", "npm test&", "npm test& echo bg", "npm test&npm run lint", 'sh -c "npm test || true"', 'bash -lc "npm test || true"'];
    for (const command of maskCases) {
      const masked = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((masked.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    }

    // An escaped-quote wrapper body cannot be cleanly tokenized; the unwrap would
    // truncate and silently drop the trailing `|| true`, so it must fail closed.
    const escapedWrapperMask = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ['bash -lc "npm test -- --grep \\"shared\\" || true"'] }, { autoRefresh: false });
    expect((escapedWrapperMask.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    // `|| false` / `|| exit 1` re-raise a failure, so they do NOT mask — the
    // runner stays exit-faithful and credited.
    for (const command of ["npm test || false", "npm test || exit 1"]) {
      const exitFaithful = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((exitFaithful.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    }

    // A package script whose body masks its own exit must not be credited via the
    // script-name heuristic; the masked body is authoritative. Covers `|| true`, a
    // command substitution that discards the runner exit (`echo $(tsc ...)`), a
    // trailing newline command (`tsc ...\nexit 0`), and an `if RUNNER; then ...; fi`
    // compound (always exits 0 regardless of the runner's result).
    // aposttypecheck: an apostrophe inside double quotes must not flip quote
    // state and leak the substitution past the stripper (the runner exit is
    // discarded by echo). condtypecheck: a runner inside `if <unknown>; then ...`
    // may never run while the script exits 0. exporttypecheck: `export X=$(tsc)`
    // returns export's own success, discarding the substitution exit.
    // bgnltypecheck: a background `&` followed by a newline must keep its
    // masking marker. yarnechobuild/pnpmechotypecheck: package-manager script
    // invocations inside a carrier-discarded substitution poison the name like
    // the bare-runner forms. exectypecheck: transparent exec-prefixes (exec/
    // nohup/timeout...) do not hide the carrier.
    for (const script of ["maskedtypecheck", "subtypecheck", "newlinetypecheck", "iftypecheck", "aposttypecheck", "condtypecheck", "exporttypecheck", "bgnltypecheck", "yarnechobuild", "pnpmechotypecheck", "exectypecheck"]) {
      const maskedScriptBody = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`npm run ${script}`] }, { autoRefresh: false });
      const kinds = (maskedScriptBody.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
      expect(kinds).not.toContain("typescript-syntax");
      expect(kinds).not.toContain("build");
    }

    // A non-matching `case` (or empty `for`) exits 0 without running its body, so
    // a build wrapped in one must not be name-credited.
    const caseBuildScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run casebuild"] }, { autoRefresh: false });
    expect((caseBuildScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("build");

    // ...but a CLEAN shell-wrapped script body keeps its name-based credit (the
    // body's exit faithfully reflects the named check), so it is not over-blocked.
    const cleanWrappedScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run wrappedbuild"] }, { autoRefresh: false });
    expect((cleanWrappedScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");

    // A substitution used as a mere ARGUMENT stays exit-faithful (`vite build
    // --define X=$(git rev-parse HEAD)`), so the build credit is not over-blocked.
    const defineBuildScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run definebuild"] }, { autoRefresh: false });
    expect((defineBuildScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");

    // A carrier with a substitution that is NOT the exit-deciding (final)
    // command must not suppress the real runner chained after it.
    const exportBuildScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run exportbuild"] }, { autoRefresh: false });
    expect((exportBuildScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");

    // ...but when a NON-RUNNER decides the exit while the named check hides in a
    // discarded substitution (`export X=$(tsc) && echo passed` always exits 0),
    // the name credit must be suppressed.
    const exportEchoScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run exportechotypecheck"] }, { autoRefresh: false });
    expect((exportEchoScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("typescript-syntax");

    // A carrier-final body with NO substitution stays faithful: `next build &&
    // echo done` short-circuits on failure, so the runner keeps its exit.
    const echoDoneBuildScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run echodonebuild"] }, { autoRefresh: false });
    expect((echoDoneBuildScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");

    // ...and a substitution that is an ARGUMENT to a real runner does not make a
    // trailing echo unsafe — `vite build --define X=$(git rev) && echo ok` keeps
    // the runner's failure via && short-circuit.
    const defineEchoBuildScript = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run defineechobuild"] }, { autoRefresh: false });
    expect((defineEchoBuildScript.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");

    // Regex evidence on the stripped body survives an untrusted NAME: a real
    // runner outside any substitution stays exit-faithful via && even when the
    // chain ends in a status echo that carries a substitution.
    for (const script of ["buildechohash", "exportnextecho"]) {
      const regexEvidence = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`npm run ${script}`] }, { autoRefresh: false });
      expect((regexEvidence.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("build");
    }

    // ...while the same launder shape hidden inside a shell wrapper still cannot
    // ride the script NAME into typescript credit.
    const wrappedExportEcho = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run wrappedexporttypecheck"] }, { autoRefresh: false });
    expect((wrappedExportEcho.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("typescript-syntax");

    // Carrier aliases do not bypass the name-trust gate: `command echo $(tsc)`
    // runs echo and discards tsc's exit just like the bare form.
    const aliasCarrier = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run aliastypecheck"] }, { autoRefresh: false });
    expect((aliasCarrier.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("typescript-syntax");

    // A trailing REAL runner cannot whitewash a discarded check: in
    // `echo $(tsc) && next build` the tsc exit is thrown away no matter what
    // ends the chain, so the typescript name credit is suppressed — while the
    // visible `next build` keeps its own regex-evidence build credit.
    const echoNextTypecheck = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run echonextypecheck"] }, { autoRefresh: false });
    const echoNextKinds = (echoNextTypecheck.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
    expect(echoNextKinds).not.toContain("typescript-syntax");
    expect(echoNextKinds).toContain("build");

    // Tool evidence comes from command-position tokens, not substrings: a path
    // containing "tsc" (`scripts/run-tsc.mjs`), an env-var named TSC, or a
    // tsc-in-substitution-plus-unknown-checker body must credit nothing, while
    // a real tsc behind a path (`./node_modules/.bin/tsc`) or a brace-grouped
    // discarded check are classified by what actually runs.
    // grouptypecheck/negtypecheck: a subshell-wrapped if-compound and a `!`
    // negation both decouple/invert the exit, so the name cannot vouch.
    for (const script of ["helper", "helper2", "flowtypecheck", "bracetypecheck", "grouptypecheck", "negtypecheck", "shhelptypecheck", "gitmsgtypecheck"]) {
      const tokenEvidence = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`npm run ${script}`] }, { autoRefresh: false });
      const kinds = (tokenEvidence.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
      expect(kinds).not.toContain("typescript-syntax");
      expect(kinds).not.toContain("build");
    }
    // bintsctypecheck: a real tsc behind a path counts via basename.
    // npxtypecheck: launcher flags (`npx -y tsc`) do not hide the tool.
    // parenstypecheck: a glued subshell still resolves tsc + --noEmit).
    for (const script of ["bintsctypecheck", "npxtypecheck", "parenstypecheck"]) {
      const realTsc = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [`npm run ${script}`] }, { autoRefresh: false });
      const kinds = (realTsc.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
      expect(kinds).toContain("typescript-syntax");
      expect(kinds).not.toContain("build");
    }
    // mixedbuild: an informational `tsc --version` does not veto the real vite
    // build beside it, and credits no typescript itself.
    const mixedBuild = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run mixedbuild"] }, { autoRefresh: false });
    const mixedKinds = (mixedBuild.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind);
    expect(mixedKinds).toContain("build");
    expect(mixedKinds).not.toContain("typescript-syntax");

    // The non-compiling veto resolves launchers too: `npx -y tsc --version`
    // cannot ride a type-ish script name into credit.
    const npxVersion = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run npxversiontypecheck"] }, { autoRefresh: false });
    expect((npxVersion.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("typescript-syntax");

    // A hygiene script invoked with --help runs nothing — no lint evidence.
    const helpVerify = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run helpverify"] }, { autoRefresh: false });
    expect((helpVerify.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("lint");

    // A subshell-wrapped compound pops on its glued closer (`done)`), so a real
    // test chained after it is not over-masked.
    const subshellThenTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ['(for d in $DIRS; do echo $d; done) && npm test'] }, { autoRefresh: false });
    expect((subshellThenTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // A carrier that interpolates only metadata (`echo $(date)`) does not poison
    // the name: the && chain stays faithful to the real runner before it.
    const dateEcho = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run datetypecheck"] }, { autoRefresh: false });
    expect((dateEcho.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).toContain("typescript-syntax");

    // Stripping a substitution must not glue surrounding words into a phrase the
    // command never contained (`vite $(x) build` is NOT `vite build`).
    const glued = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run gluecheck"] }, { autoRefresh: false });
    expect((glued.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("build");

    // FD redirection is not exit masking: `2>&1` / `&>file` / `>&2` keep the
    // runner's own exit, so the ubiquitous redirect idioms must stay covered.
    const redirectCovered = [
      "npm run test -- tests/shared.test.ts 2>&1",
      "vitest run tests/shared.test.ts 2>&1",
      "npm run test -- tests/shared.test.ts &> /tmp/codexa-redirect.log",
      "vitest run tests/shared.test.ts >&2"
    ];
    for (const command of redirectCovered) {
      const covered = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((covered.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((e) => e.target === "tests/shared.test.ts")?.status).toBe("covered");
    }

    // A masking operator hidden inside one or two nested shell wrappers must not
    // be laundered into coverage: nested quoting that the tokenizer cannot parse
    // fails closed (the inner `|| true` survives or the runner is recorded
    // unknown), never crediting the test as passed.
    const nestedMask = ['sh -c "npm test || true"', "sh -c \"sh -c 'npm test || true'\"", "bash -lc \"sh -c 'npm test || true'\""];
    for (const command of nestedMask) {
      const masked = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((masked.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    }

    // ...but a clean shell-wrapped runner (no mask) stays credited.
    const wrappedClean = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ['sh -c "npm test"'] }, { autoRefresh: false });
    expect((wrappedClean.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // Reported structured envelope must not launder a masked command into coverage.
    const maskedEnvelope = await postEditReviewQuery(
      repo,
      { taskId: "verification-coverage", ranCommandReports: [{ command: "npm test || true", cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0 }] },
      { autoRefresh: false }
    );
    expect((maskedEnvelope.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((e) => e.target === "tests/shared.test.ts")?.status).toBe("missing");

    // A structured envelope whose command text hides the mask inside a shell
    // wrapper (so a top-level operator scan misses it) must still be deferred to
    // the unwrapping per-segment analyzer and recorded as not covered.
    const maskedWrappedEnvelope = await postEditReviewQuery(
      repo,
      { taskId: "verification-coverage", ranCommandReports: [{ command: 'sh -c "npm test || true"', cwd: repo, packageManager: "npm", packageRoot: ".", scriptName: "test", args: [], exitCode: 0 }] },
      { autoRefresh: false }
    );
    expect((maskedWrappedEnvelope.data as { verificationLedger: Array<{ target: string; status: string }> }).verificationLedger.find((e) => e.target === "tests/shared.test.ts")?.status).toBe("missing");

    // Over-block guard: a real test that is the exit-deciding (last) command in a
    // `;` sequence stays covered even though an earlier runner precedes it.
    const buildThenTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm run build ; npm test"] }, { autoRefresh: false });
    expect((buildThenTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // `tsc --help` / `--showConfig` do not typecheck, directly or via a package script.
    for (const command of ["tsc --help", "tsc --showConfig", "tsc --listFilesOnly", "npx tsc --version"]) {
      const tscNonCompiling = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((tscNonCompiling.data as { verificationCoverage: Array<{ kind: string }> }).verificationCoverage.map((e) => e.kind)).not.toContain("typescript-syntax");
    }

    const simpleIfFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["if true; then npm test; fi"] }, { autoRefresh: false });
    expect((simpleIfFlow.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const falseIfFlow = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["if false; then npm test; fi"] }, { autoRefresh: false });
    expect((falseIfFlow.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    // A runner inside `if <unknown-cond>; then ...; fi` (or a while/for/case body)
    // may never execute while the construct still exits 0, so it must not count
    // as covering — only a statically-true condition keeps the branch credited.
    // Nesting must not drain the masking: an inner compound glued behind `then`/
    // `do` pushes its own entry, so its `fi`/`done` cannot unmask the outer body;
    // a dead `if false` skip survives an inner `fi`; an `elif` branch is
    // conditionally-reached even under an `if true`; and a trailing `cd` is a
    // real exit-overriding command (`cd` exits 0), not invisible.
    const compoundMaskCases = [
      'if [ -n "$CI" ]; then npm test; fi',
      'while [ -n "$RETRY" ]; do npm test; done',
      "for d in $DIRS; do npm test; done",
      'if [ "$CI" = true ]; then if [ -f tsconfig.json ]; then tsc --noEmit; fi; npm test; fi',
      "for a in 1; do for b in 2; do echo x; done; npm test; done",
      "if false; then if true; then echo x; fi; npm test; fi",
      "if true; then echo ok; elif true; then npm test; fi",
      "npm test ; cd /tmp",
      "false && cd /tmp && npm test",
      '{ if [ -n "$CI" ]; then npm test; fi; }',
      '( if [ -n "$CI" ]; then npm test; fi )',
      "true || if true; then npm test; fi",
      "npm test ; { echo done; }",
      "false && if true; then true; fi && npm test",
      "git fetch || npm test",
      "if true; then true; fi || npm test",
      "if false; then echo x; fi || npm test",
      "git fetch ||\nnpm test",
      "git fetch || false || npm test",
      "git fetch || if true; then npm test; fi",
      "git fetch ||\n# retry\nnpm test",
      "cat > notes.txt <<EOF\nnpm test\nEOF",
      "npm run lint ||#fallback\nnpm test",
      "npm test # docs use <<EOF\ntrue",
      "cat <<-EOF\n\tnpm test\n\tEOF",
      "cat <<9\nnpm test\n9",
      "cat <<EOF-1\nblah\nEOF\nnpm test\nEOF-1",
      "cat <<CONFIG.json > app.json\nnpm test\nCONFIG.json"
    ];
    for (const command of compoundMaskCases) {
      const unknownCompound = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: [command] }, { autoRefresh: false });
      expect((unknownCompound.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");
    }

    // ...while a nested compound with statically-true conditions all the way
    // down keeps its credit, and a subshell-wrapped statically-true compound
    // pops its glued closer cleanly.
    const nestedTrueIf = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["if true; then if true; then npm test; fi; fi"] }, { autoRefresh: false });
    expect((nestedTrueIf.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    const wrappedTrueIf = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["(if true; then npm test; fi)"] }, { autoRefresh: false });
    expect((wrappedTrueIf.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // A multi-line && chain is a line continuation, not separate statements:
    // the pending operator binds across the newline and the chain stays
    // exit-faithful, so the test keeps its credit.
    const multilineChain = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm ci &&\nnpm run build &&\nnpm test"] }, { autoRefresh: false });
    expect((multilineChain.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    // A trailing comment is not a command, and a heredoc BODY is data — neither
    // affects the real runner's credit on its own line.
    const commentedTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["npm test # smoke"] }, { autoRefresh: false });
    expect((commentedTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    const heredocThenTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["cat <<EOF\nnot a real run\nEOF\nnpm test"] }, { autoRefresh: false });
    expect((heredocThenTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);
    // Arithmetic `<<` is a shift, not a heredoc — the following real test still counts.
    const arithThenTest = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["echo $((1 << 2))\nnpm test"] }, { autoRefresh: false });
    expect((arithThenTest.data as { testsNotRun: unknown[] }).testsNotRun).toEqual([]);

    const falseAndFallback = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["false && npm test"] }, { autoRefresh: false });
    expect((falseAndFallback.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

    const trueOrFallback = await postEditReviewQuery(repo, { taskId: "verification-coverage", ranCommands: ["true || npm test"] }, { autoRefresh: false });
    expect((trueOrFallback.data as { testsNotRun: Array<{ path: string }> }).testsNotRun.map((test) => test.path)).toContain("tests/shared.test.ts");

  });
});
