import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");
const npmWorkflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
function stepScript(workflow: string, name: string) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  const script = step?.split("        run: |\n")[1];
  if (!script) throw new Error(`Missing executable workflow step: ${name}`);
  return script.split("\n").map(line => line.replace(/^          /, "")).join("\n");
}
const publishScript = stepScript(releaseWorkflow, "Start publishing the created release");
const prScript = stepScript(releaseWorkflow, "Start checks for the release PR");
const visibilityScript = stepScript(npmWorkflow, "Wait for the npm package to become visible")
  .split("node --input-type=module <<'NODE'\n")[1]?.split("\nNODE")[0];
if (!visibilityScript) throw new Error("Missing npm visibility script");
const fixtureRepo = "OWNER/REPO";
const validPr = {
  state: "open", base: { ref: "main", repo: { full_name: fixtureRepo } },
  head: { ref: "release-please--branches--main", repo: { full_name: fixtureRepo } }
};
function runDispatch(script: string, options: { tag?: string; output?: string; pr?: unknown; fail?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-dispatch-"));
  const calls = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
if (process.env.FIXTURE_FAIL === 'true') process.exit(1);
if (args[0] === 'api') process.stdout.write(process.env.FIXTURE_PR);
`, { mode: 0o700 });
  writeFileSync(calls, "");
  try {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: fixtureRepo,
        RELEASE_TAG: options.tag ?? "v1.2.3", RELEASE_PR: options.output ?? '{"number":123}',
        FIXTURE_PR: JSON.stringify(options.pr ?? validPr), FIXTURE_CALLS: calls, FIXTURE_FAIL: String(options.fail ?? false) },
      encoding: "utf8", timeout: 5000
    });
    return { status: result.status, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), output: result.stdout + result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("Release Please workflow dispatch boundary", () => {
  it("dispatches publishing on main with the exact stable tag and publish enabled", () => {
    const result = runDispatch(publishScript);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([["workflow", "run", "npm-publish.yml", "--repo", fixtureRepo, "--ref", "main", "--raw-field", "tag=v1.2.3", "--raw-field", "publish=true"]]);
  });
  it.each(["", "v1.2.3-beta.1", "v1.2.3; echo unexpected", "--ref=topic", "v1.2.3\nother"])("rejects unsafe release tags before invoking GitHub: %j", tag => {
    const result = runDispatch(publishScript, { tag });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
  it.each(["release-please--branches--main", "release-please--branches--main--components--codexa"])("dispatches CI at the verified release PR branch: %s", ref => {
    const result = runDispatch(prScript, { pr: { ...validPr, head: { ...validPr.head, ref } } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([["api", "repos/OWNER/REPO/pulls/123"], ["workflow", "run", "check.yml", "--repo", fixtureRepo, "--ref", ref]]);
  });
  it.each(["{}", '{"number":"123; echo unexpected"}', '{"number":-1}', "invalid"])("rejects invalid PR outputs before invoking GitHub: %j", output => {
    const result = runDispatch(prScript, { output });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
  it.each([
    { ...validPr, state: "closed" },
    { ...validPr, base: { ...validPr.base, ref: "topic" } },
    { ...validPr, base: { ...validPr.base, repo: { full_name: "OTHER/REPO" } } },
    { ...validPr, head: { ...validPr.head, repo: { full_name: "FORK/REPO" } } },
    { ...validPr, head: { ...validPr.head, ref: "unrelated" } }
  ])("does not start CI for an unexpected PR: %j", pr => {
    const result = runDispatch(prScript, { pr });
    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
  });
  it("reports dispatch failures instead of claiming a release was queued", () => {
    expect(runDispatch(publishScript, { fail: true }).status).not.toBe(0);
  });
});

function runVisibility(statuses: Array<number | "timeout" | "network" | "body-timeout" | "body-disconnect" | "malformed" | "bug">, mismatch = false) {
  const dir = mkdtempSync(join(tmpdir(), "release-visibility-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/package", version: "1.2.3" }));
  const mocks = `
    const statuses = ${JSON.stringify(statuses)};
    globalThis.setTimeout = callback => callback();
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://registry.npmjs.org/%40example%2Fpackage/1.2.3' || options.redirect !== 'error' || !options.signal) throw new Error('Unsafe registry request');
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (status === 'timeout') throw new DOMException('Timeout fixture', 'TimeoutError');
      if (status === 'network') throw new TypeError('fetch failed');
      if (status === 'bug') throw new Error('Unexpected programming error');
      if (status === 'body-timeout') return { ok: true, status: 200, json: async () => { throw new DOMException('Body timeout fixture', 'TimeoutError'); } };
      if (status === 'body-disconnect') return { ok: true, status: 200, json: async () => { throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }); } };
      if (status === 'malformed') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON fixture'); } };
      return { ok: status === 200, status, json: async () => ({ name: '@example/package', version: ${JSON.stringify(mismatch ? "0.0.0" : "1.2.3")}, dist: { tarball: 'https://registry.npmjs.org/package.tgz' } }) };
    };
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", mocks + visibilityScript], { cwd: dir, encoding: "utf8", timeout: 5000 });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("npm visibility before MCP publication", () => {
  it("recovers from request, connection, and response-body failures", () => {
    const result = runVisibility(["timeout", "network", "body-timeout", "body-disconnect", 200]);
    expect(result.status).toBe(0);
    expect(result.output.match(/retrying/g)).toHaveLength(4);
    expect(result.output).toContain("@example/package@1.2.3 is visible on npm.");
  });
  it("bounds repeated network failures and explains recovery", () => {
    const result = runVisibility(["timeout"]);
    expect(result.status).not.toBe(0);
    expect(result.output.match(/retrying/g)).toHaveLength(29);
    expect(result.output).toContain("A public 404 does not prove the upload failed");
  });
  it.each(["bug", "malformed"] as const)("does not retry permanent %s errors", failure => {
    const result = runVisibility([failure]);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("retrying");
  });
  it("waits through asynchronous processing and temporary registry errors", () => {
    const result = runVisibility([404, 429, 503, 200]);
    expect(result.status).toBe(0);
    expect(result.output.match(/retrying/g)).toHaveLength(3);
    expect(result.output).toContain("@example/package@1.2.3 is visible on npm.");
  });
  it("fails with a recovery instruction when npm never exposes the version", () => {
    const result = runVisibility([404]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Timed out waiting for npm publication");
    expect(result.output.match(/retrying/g)).toHaveLength(29);
  });
  it("does not retry an authentication error", () => {
    const result = runVisibility([401]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 401");
    expect(result.output).not.toContain("retrying");
  });
  it("rejects a mismatched package version", () => {
    expect(runVisibility([200], true).status).not.toBe(0);
  });
});


const diagnosticScript = stepScript(npmWorkflow, "Diagnose npm trusted publishing")
  .split("node --input-type=module <<'NODE'\n")[1]?.split("\nNODE")[0];
if (!diagnosticScript) throw new Error("Missing npm diagnostic script");
function runDiagnostic(mode: string, version = "1.2.3") {
  const mocks = `
    const mode = ${JSON.stringify(mode)};
    const token = 'fixture-secret';
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      if (options.redirect !== 'error' || !options.signal) throw new Error('Unsafe request');
      if (calls === 1) {
        if (String(url) !== 'https://identity.example.com/token?audience=npm%3Aregistry.npmjs.org' || options.headers.Authorization !== 'Bearer fixture-request') process.exit(20);
        return { ok: true, json: async () => ({ value: 'header.' + Buffer.from(JSON.stringify({repository: 'OWNER/REPO'})).toString('base64url') + '.signature' }) };
      }
      if (calls === 2) {
        if (url !== 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40mirnoorata%2Fcodexa' || options.method !== 'POST') process.exit(21);
        return { ok: true, json: async () => ({ token }) };
      }
      if (calls !== 3 || url !== 'https://registry.npmjs.org/-/package/%40mirnoorata%2Fcodexa/version/1.2.3/status' || options.method && options.method !== 'GET' || options.headers.Authorization !== 'Bearer ' + token) process.exit(22);
      if (mode === 'network') throw new Error(token);
      return { ok: !/^\\d+$/.test(mode), status: Number(mode) || 200, json: async () => {
        if (mode === 'malformed') throw new SyntaxError(token);
        return { packageName: mode === 'wrong-package' ? '@other/package' : '@mirnoorata/codexa',
          version: mode === 'wrong-version' ? '0.0.0' : '1.2.3',
          status: mode === 'secret' ? token : mode === 'injection' ? '\\n::error::' + token : 'validating', detail: token };
      } };
    };
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", mocks + diagnosticScript], {
    env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.example.com/token", PACKAGE_VERSION: version },
    encoding: "utf8", timeout: 5000
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
describe("read-only npm lifecycle diagnostic", () => {
  it("uses the exchanged credential for an exact-version GET and reports only the validated state", () => {
    const result = runDiagnostic("valid");
    expect(result.status).toBe(0);
    expect(result.output).toContain("npm lifecycle status for @mirnoorata/codexa@1.2.3: validating");
    expect(result.output).not.toContain("fixture-secret");
  });
  it.each(["401", "403", "404", "429", "503", "network", "malformed", "wrong-package", "wrong-version", "secret", "injection"])("reports %s as unavailable without leaking data or failing the credential diagnostic", mode => {
    const result = runDiagnostic(mode);
    expect(result.status).toBe(0);
    expect(result.output).toContain("npm lifecycle status unavailable");
    expect(result.output).toContain("npm trusted publishing accepted");
    expect(result.output).not.toContain("fixture-secret");
    expect(result.output).not.toContain("fixture-request");
    expect(result.output).not.toContain("::error::");
  });
  it.each(["", "../other", "1.2.3-beta.1", "01.2.3"])("rejects invalid version %j", version => {
    expect(runDiagnostic("valid", version).status).not.toBe(0);
  });
});
