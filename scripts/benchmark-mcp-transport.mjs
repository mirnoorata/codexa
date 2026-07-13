#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_RELEASES = Object.freeze({
  "v0.12.0": Object.freeze({
    version: "0.12.0",
    commit: "68061b022cfc9f4dcc1aaf3d7776710196cc69b0",
    packageLockSha256: "908d5a0148630493a65e08f562aab0c47f200c4177c2f1f5e972eb130a3dd1e5",
    cliSha256: "ea90fb40a0cf2b9825707f511ba8013644e8a0492349f58741f7ded47f110e0d",
    distTreeSha256: "8d8805e043f74a5df1ffaab72f63d9f38e91a2080ee99295f8a6102af2bfa6be"
  })
});
const options = parseArgs(process.argv.slice(2));
const repoRoot = canonicalPath(options.repo ?? process.cwd());
const repoHead = requiredGitHead(repoRoot);
const repoClean = gitClean(repoRoot);
const candidateCli = path.resolve(options.candidateCli ?? path.join(scriptRepoRoot, "dist/cli.js"));
const baselineTools = options.baselineTools ?? "bare";
const candidateTools = options.candidateTools ?? "core";
const calls = options.calls ?? 5;
const task = options.task ?? "Measure generic repository context overhead";
const file = normalizeRepoFile(repoRoot, options.file ?? "package.json");

let materializedBaseline;
try {
  materializedBaseline = options.releaseBaseline
    ? materializePinnedRelease(scriptRepoRoot, options.releaseBaseline)
    : undefined;
  const baselineCli = materializedBaseline?.cli ?? path.resolve(options.baselineCli ?? path.join(scriptRepoRoot, "dist/cli.js"));
  for (const [label, cli] of [["baseline", baselineCli], ["candidate", candidateCli]]) {
    if (!existsSync(cli)) throw new Error(`${label} CLI does not exist: ${cli}`);
  }

  const baselineIdentity = executableIdentity(baselineCli);
  const candidateIdentity = executableIdentity(candidateCli);
  const baseline = await measureArm("baseline", baselineCli, baselineTools, repoHead);
  const candidate = await measureArm("candidate", candidateCli, candidateTools, repoHead);
  const advertisedLogicalOperationNameParity = equalArrays(baseline.advertisedLogicalOperationNames, candidate.advertisedLogicalOperationNames);
  const baselineAdvertisementAndDiscoveryBytes = baseline.toolsListDecodedPayloadBytes + baseline.capabilityDiscoveryDecodedPayloadBytes;
  const candidateAdvertisementAndDiscoveryBytes = candidate.toolsListDecodedPayloadBytes + candidate.capabilityDiscoveryDecodedPayloadBytes;
  const checks = {
    cleanTargetCheckout: repoClean,
    freshIndexedCheckout: baseline.fresh && candidate.fresh,
    baselineServerMatchesExecutable: baseline.serverIdentity.name === "codexa" && baseline.serverIdentity.version === baselineIdentity.version,
    candidateServerMatchesExecutable: candidate.serverIdentity.name === "codexa" && candidate.serverIdentity.version === candidateIdentity.version,
    pinnedBaselineServerIdentity: !materializedBaseline || (baseline.serverIdentity.name === "codexa" && baseline.serverIdentity.version === materializedBaseline.release.version),
    advertisedLogicalOperationNameParity,
    directSchemaReduction: candidate.directToolCount < baseline.directToolCount,
    advertisementAndDiscoveryPayloadReduction: candidateAdvertisementAndDiscoveryBytes < baselineAdvertisementAndDiscoveryBytes,
    candidateDetailedResourceReadable: candidate.detailedResourceReadable === true,
    candidateReceiptOrdering: candidate.receiptFlags[0] === false && candidate.receiptFlags.slice(1).every(Boolean)
  };
  const report = {
    schemaVersion: 2,
    kind: "codexa-mcp-decoded-application-payload-comparison",
    comparisonMode: materializedBaseline
      ? "pinned-release-versus-candidate"
      : baselineCli === candidateCli && baselineTools !== candidateTools
        ? "same-build-exposure"
        : "explicit-executables",
    measurement: {
      unit: "utf8-bytes-of-json-serialized-decoded-mcp-application-payload",
      includes: ["tools/list result", "freshness result", "capability discovery result when requested", "task_brief results", "detailed resource response when fetched"],
      excludes: ["JSON-RPC framing", "stdio framing", "model tokens", "provider prompt serialization", "network overhead"]
    },
    input: {
      repoRoot,
      repoHead,
      repoClean,
      task,
      file,
      calls,
      baseline: { tools: baselineTools, release: materializedBaseline?.release, executable: baselineIdentity },
      candidate: { tools: candidateTools, executable: candidateIdentity }
    },
    baseline,
    candidate,
    comparison: {
      advertisedLogicalOperationNameParity,
      baselineAdvertisementAndDiscoveryDecodedPayloadBytes: baselineAdvertisementAndDiscoveryBytes,
      candidateAdvertisementAndDiscoveryDecodedPayloadBytes: candidateAdvertisementAndDiscoveryBytes,
      advertisementAndDiscoveryDecodedPayloadReductionPercent: reductionPercent(baselineAdvertisementAndDiscoveryBytes, candidateAdvertisementAndDiscoveryBytes),
      toolsListDecodedPayloadReductionPercent: reductionPercent(baseline.toolsListDecodedPayloadBytes, candidate.toolsListDecodedPayloadBytes),
      firstTaskResultDecodedPayloadReductionPercent: reductionPercent(baseline.firstTaskResultDecodedPayloadBytes, candidate.firstTaskResultDecodedPayloadBytes),
      repeatedTaskResultDecodedPayloadReductionPercent: reductionPercent(baseline.repeatedTaskResultDecodedPayloadMedianBytes, candidate.repeatedTaskResultDecodedPayloadMedianBytes)
    },
    checks,
    passed: Object.values(checks).every(Boolean),
    claimBoundary: "Reproducible decoded MCP application-payload mechanics on one clean indexed checkout; advertisement plus optional capability discovery must be strictly smaller with no claimed effect-size threshold, task-result reductions remain observations because tiny tasks can be dominated by fixed decision-safety metadata, advertised operation-name parity is not execution parity, and this does not measure agent quality, task success, model capability, tokens, cost, wire bytes, or no-Codexa net value."
  };

  if (options.output) {
    const output = path.resolve(options.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed && !options.warnOnly) process.exitCode = 1;
} finally {
  materializedBaseline?.cleanup();
}

async function measureArm(label, cli, tools, expectedHead) {
  const transportArgs = [cli, "serve", repoRoot, "--no-auto-refresh", "--session-memory", "off", ...(tools === "bare" ? [] : ["--tools", tools])];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: transportArgs,
    env: process.env,
    stderr: "pipe"
  });
  const client = new Client({ name: `codexa-transport-${label}`, version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), 15_000, `${label} MCP connect`);
    const initializedServer = client.getServerVersion();
    if (!initializedServer || typeof initializedServer.name !== "string" || typeof initializedServer.version !== "string") {
      throw new Error(`${label} MCP initialize response omitted server identity`);
    }
    const listed = await withTimeout(client.listTools(), 15_000, `${label} tools/list`);
    const directToolNames = listed.tools.map((tool) => tool.name).sort();
    const discovery = directToolNames.includes("capabilities")
      ? await capabilityNames(client, label)
      : { names: [], decodedPayloadBytes: 0 };
    const advertisedLogicalOperationNames = [...new Set([...directToolNames.filter((name) => name !== "capabilities"), ...discovery.names])].sort();
    const freshnessResult = await withTimeout(client.callTool({ name: "freshness", arguments: {} }), 15_000, `${label} freshness`);
    assertSuccessfulToolResult(freshnessResult, `${label} freshness`);
    const freshness = findFreshness(freshnessResult.structuredContent);
    const freshnessIdentity = inspectFreshnessIdentity(freshness, repoRoot, expectedHead);
    const results = [];
    const receiptFlags = [];
    let resultUri;
    let detailedResourceBytes;
    let detailedResourceDecodedPayloadBytes;
    let detailedResourceReadable = false;
    for (let index = 0; index < calls; index += 1) {
      const result = await withTimeout(client.callTool({
        name: "task_brief",
        arguments: { task, files: [file], tokenBudget: 1_600, limit: 6, includeSnippets: false }
      }), 30_000, `${label} task_brief call ${index + 1}`);
      assertSuccessfulToolResult(result, `${label} task_brief call ${index + 1}`);
      results.push(utf8Bytes(result));
      const delivery = queryDelivery(result.structuredContent);
      receiptFlags.push(delivery?.unchangedReceipt === true);
      if (!resultUri && typeof delivery?.resultUri === "string") resultUri = delivery.resultUri;
    }
    if (resultUri) {
      try {
        const resource = await withTimeout(client.readResource({ uri: resultUri }), 15_000, `${label} detailed resource`);
        const text = resource.contents.find((entry) => typeof entry.text === "string")?.text;
        if (typeof text === "string") {
          JSON.parse(text);
          detailedResourceBytes = Buffer.byteLength(text, "utf8");
          detailedResourceDecodedPayloadBytes = utf8Bytes(resource);
          detailedResourceReadable = true;
        }
      } catch {
        detailedResourceReadable = false;
      }
    }
    return {
      label,
      tools,
      serverIdentity: { name: initializedServer.name, version: initializedServer.version },
      fresh: freshnessIdentity.valid,
      freshnessIdentity,
      freshnessDecodedPayloadBytes: utf8Bytes(freshnessResult),
      directToolCount: directToolNames.length,
      directToolNames,
      advertisedLogicalOperationCount: advertisedLogicalOperationNames.length,
      advertisedLogicalOperationNames,
      capabilityDiscoveryDecodedPayloadBytes: discovery.decodedPayloadBytes,
      toolsListDecodedPayloadBytes: utf8Bytes(listed),
      taskResultDecodedPayloadBytes: results,
      firstTaskResultDecodedPayloadBytes: results[0] ?? 0,
      repeatedTaskResultDecodedPayloadMedianBytes: median(results.slice(1)),
      receiptFlags,
      unchangedReceiptCount: receiptFlags.filter(Boolean).length,
      detailedResultUri: resultUri,
      detailedResourceBytes,
      detailedResourceDecodedPayloadBytes,
      detailedResourceReadable
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function capabilityNames(client, label) {
  const result = await withTimeout(client.callTool({
    name: "capabilities",
    arguments: { action: "list", responseFormat: "detailed" }
  }), 30_000, `${label} capabilities list`);
  assertSuccessfulToolResult(result, `${label} capabilities list`);
  const data = queryData(result.structuredContent);
  return {
    names: Array.isArray(data?.operations)
      ? data.operations.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string" ? [entry.name] : [])
      : [],
    decodedPayloadBytes: utf8Bytes(result)
  };
}

function queryData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
}

function queryDelivery(value) {
  const data = queryData(value);
  return data?.delivery && typeof data.delivery === "object" && !Array.isArray(data.delivery) ? data.delivery : undefined;
}

function findFreshness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.stale === "boolean" || typeof value.missing === "boolean") return value;
  return findFreshness(value.freshness) ?? findFreshness(value.data);
}

function inspectFreshnessIdentity(freshness, expectedRepoRoot, expectedHead) {
  const actualRepoRoot = typeof freshness?.repoRoot === "string" ? canonicalPathOrUndefined(freshness.repoRoot) : undefined;
  const actualHead = typeof freshness?.headCommit === "string" ? freshness.headCommit : undefined;
  const parserErrorCount = typeof freshness?.parserErrorCount === "number" && Number.isInteger(freshness.parserErrorCount)
    ? freshness.parserErrorCount
    : undefined;
  const failures = [];
  if (!freshness) failures.push("missing freshness envelope");
  if (freshness?.missing !== false) failures.push("index missing state was not explicitly false");
  if (freshness?.stale !== false) failures.push("index stale state was not explicitly false");
  if (actualRepoRoot !== expectedRepoRoot) failures.push(`indexed repoRoot mismatch: expected ${expectedRepoRoot}, received ${actualRepoRoot ?? "missing"}`);
  if (actualHead !== expectedHead) failures.push(`indexed HEAD mismatch: expected ${expectedHead}, received ${actualHead ?? "missing"}`);
  if (parserErrorCount !== 0) failures.push(`parserErrorCount must be 0, received ${parserErrorCount ?? "missing"}`);
  return {
    valid: failures.length === 0,
    reason: typeof freshness?.reason === "string" ? freshness.reason : undefined,
    repoRoot: actualRepoRoot,
    headCommit: actualHead,
    parserErrorCount,
    failures
  };
}

function assertSuccessfulToolResult(result, label) {
  if (!result || typeof result !== "object" || result.isError === true) {
    throw new Error(`${label} returned an MCP error result`);
  }
  if (!result.structuredContent || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)) {
    throw new Error(`${label} returned no structured MCP payload`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--repo", "--baseline-cli", "--release-baseline", "--candidate-cli", "--baseline-tools", "--candidate-tools", "--task", "--file", "--calls", "--output"].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      parsed[key] = flag === "--calls" ? positiveInteger(value, flag) : value;
    } else if (flag === "--warn-only") parsed.warnOnly = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  for (const key of ["baselineTools", "candidateTools"]) {
    if (parsed[key] !== undefined && !["bare", "full", "core"].includes(parsed[key])) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be bare, full, or core`);
  }
  if (parsed.baselineCli && parsed.releaseBaseline) throw new Error("--baseline-cli and --release-baseline are mutually exclusive");
  if (parsed.releaseBaseline && !Object.hasOwn(PINNED_RELEASES, parsed.releaseBaseline)) {
    throw new Error(`--release-baseline must be one of: ${Object.keys(PINNED_RELEASES).join(", ")}`);
  }
  return parsed;
}

function materializePinnedRelease(sourceRepo, releaseName) {
  const release = PINNED_RELEASES[releaseName];
  const sourceGitRoot = gitRoot(sourceRepo);
  if (!sourceGitRoot) throw new Error("--release-baseline requires a Git source checkout");
  const localLock = path.join(sourceGitRoot, "package-lock.json");
  if (!existsSync(localLock) || sha256File(localLock) !== release.packageLockSha256) {
    throw new Error(`Cannot reuse local node_modules for ${releaseName}: current package-lock.json must match pinned SHA-256 ${release.packageLockSha256}`);
  }
  const nodeModules = path.join(sourceGitRoot, "node_modules");
  if (!existsSync(nodeModules)) throw new Error(`Cannot build ${releaseName} offline: install dependencies in ${sourceGitRoot} first`);
  try {
    execFileSync("git", ["cat-file", "-e", `${release.commit}^{commit}`], { cwd: sourceGitRoot, stdio: "ignore" });
  } catch {
    throw new Error(`Pinned ${releaseName} commit ${release.commit} is absent locally; fetch repository history explicitly before running this offline benchmark`);
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), `codexa-${releaseName.replace(/[^a-z0-9.-]/giu, "-")}-`));
  const checkout = path.join(tempRoot, "source");
  try {
    execFileSync("git", ["clone", "--quiet", "--no-checkout", "--shared", sourceGitRoot, checkout], { stdio: "ignore" });
    execFileSync("git", ["checkout", "--quiet", "--detach", release.commit], { cwd: checkout, stdio: "ignore" });
    const pinnedLock = path.join(checkout, "package-lock.json");
    if (sha256File(pinnedLock) !== release.packageLockSha256) throw new Error(`${releaseName} package-lock.json does not match its pinned digest`);
    writeFileSync(path.join(checkout, ".git", "info", "exclude"), "node_modules\n", "utf8");
    symlinkSync(nodeModules, path.join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--silent"], { cwd: checkout, stdio: "ignore" });
    const cli = path.join(checkout, "dist", "cli.js");
    const identity = executableIdentity(cli);
    if (identity.version !== release.version) throw new Error(`${releaseName} built version ${identity.version}; expected ${release.version}`);
    if (identity.sourceCommit !== release.commit) throw new Error(`${releaseName} materialized commit ${identity.sourceCommit ?? "unknown"}; expected ${release.commit}`);
    if (identity.cliSha256 !== release.cliSha256) throw new Error(`${releaseName} CLI digest ${identity.cliSha256}; expected ${release.cliSha256}`);
    if (identity.distTreeSha256 !== release.distTreeSha256) {
      throw new Error(`${releaseName} dist digest ${identity.distTreeSha256}; expected ${release.distTreeSha256}`);
    }
    if (identity.sourceClean !== true) throw new Error(`${releaseName} materialized source is not clean`);
    return {
      cli,
      release: {
        name: releaseName,
        version: release.version,
        sourceCommit: release.commit,
        packageLockSha256: release.packageLockSha256,
        artifactKind: "locally-built-tagged-source",
        npmTarballIdentity: false
      },
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function executableIdentity(cli) {
  const resolvedCli = canonicalPath(cli);
  const sourceRoot = gitRoot(path.dirname(resolvedCli));
  const version = execFileSync(process.execPath, [resolvedCli, "--version"], {
    cwd: sourceRoot ?? path.dirname(resolvedCli),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const packageLock = sourceRoot ? path.join(sourceRoot, "package-lock.json") : undefined;
  return {
    cli: resolvedCli,
    version,
    cliSha256: sha256File(resolvedCli),
    distTreeSha256: sha256Tree(path.dirname(resolvedCli)),
    sourceRoot,
    sourceCommit: sourceRoot ? requiredGitHead(sourceRoot) : undefined,
    sourceClean: sourceRoot ? gitClean(sourceRoot) : undefined,
    packageLockSha256: packageLock && existsSync(packageLock) ? sha256File(packageLock) : undefined
  };
}

function sha256Tree(root) {
  const hash = createHash("sha256");
  hash.update("codexa-dist-tree-v1\0");
  for (const file of regularTreeFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const contents = readFileSync(file);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(contents.length));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function regularTreeFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) throw new Error(`Executable dist tree must not contain symlinks: ${target}`);
      if (stats.isDirectory()) visit(target);
      else if (stats.isFile()) files.push(target);
      else throw new Error(`Executable dist tree contains an unsupported entry: ${target}`);
    }
  };
  visit(root);
  return files;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  return realpathSync(resolved);
}

function canonicalPathOrUndefined(value) {
  try {
    return canonicalPath(value);
  } catch {
    return undefined;
  }
}

function gitRoot(target) {
  try {
    return canonicalPath(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch {
    return undefined;
  }
}

function requiredGitHead(repo) {
  const head = gitHead(repo);
  if (!head || !/^[a-f0-9]{40}$/u.test(head)) throw new Error(`Repository has no full Git HEAD identity: ${repo}`);
  return head;
}

function gitClean(repo) {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim().length === 0;
}

function normalizeRepoFile(repo, value) {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//u, "");
  const absolute = path.resolve(repo, normalized);
  const relative = path.relative(repo, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || !existsSync(absolute)) throw new Error(`--file must name an existing repository file: ${value}`);
  return relative;
}

function positiveInteger(value, flag) {
  if (!/^\d+$/u.test(value) || Number(value) < 2 || Number(value) > 20) throw new Error(`${flag} must be an integer from 2 through 20`);
  return Number(value);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function reductionPercent(baselineValue, candidateValue) {
  if (baselineValue <= 0) return undefined;
  return Math.round((1 - candidateValue / baselineValue) * 1_000) / 10;
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitHead(repo) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
