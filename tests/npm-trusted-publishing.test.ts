import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
const diagnostic = workflow.split("node --input-type=module <<'NODE'\n")[1]?.split("          NODE\n")[0];
if (!diagnostic) throw new Error("Missing executable npm authentication diagnostic");
const requestToken = "fixture-github-request-secret";
const idToken = `fixture.${Buffer.from(JSON.stringify({ repository: "OWNER/REPO", workflow_ref: "OWNER/REPO/.github/workflows/publish.yml@refs/heads/main" })).toString("base64url")}.signature`;
const resolver = workflow.split("        run: |\n")[1]?.split("\n  publish:")[0];
if (!resolver) throw new Error("Missing release resolver");

function runDiagnostic(options: { status?: number; message?: string; missingIdentity?: boolean; missingCredential?: boolean; noOidc?: boolean; redirect?: boolean } = {}) {
  const fixture = `
    const options = ${JSON.stringify(options)};
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (init.redirect !== 'error' || !init.signal) throw new Error('Unsafe request options');
      if (options.redirect) throw new Error('Redirect refused');
      if (calls.length === 1) {
        if (String(url) !== 'https://oidc.example.invalid/token?audience=npm%3Aregistry.npmjs.org') throw new Error('Wrong audience');
        if (init.headers.Authorization !== 'Bearer ' + ${JSON.stringify(requestToken)}) throw new Error('Wrong GitHub credential');
        return { ok: true, json: async () => options.missingIdentity ? {} : { value: ${JSON.stringify(idToken)} } };
      }
      if (calls.length !== 2 || init.method !== 'POST' || String(url) !== 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40mirnoorata%2Fcodexa') throw new Error('Unexpected network request');
      if (init.headers.Authorization !== 'Bearer ' + ${JSON.stringify(idToken)}) throw new Error('Wrong npm exchange credential');
      return { ok: (options.status || 201) === 201, status: options.status || 201, json: async () => options.status ? { message: options.message } : options.missingCredential ? {} : { token: 'fixture-npm-publish-secret' } };
    };
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", fixture + diagnostic], {
    env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: options.noOidc ? "" : "https://oidc.example.invalid/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken },
    encoding: "utf8", timeout: 5000
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("npm trusted publishing boundary", () => {
  it("verifies the OIDC exchange without publishing or exposing credentials", () => {
    const result = runDiagnostic();
    expect(result.status).toBe(0);
    expect(result.output).toContain("nothing was published");
    for (const secret of [requestToken, idToken, "fixture-npm-publish-secret"]) expect(result.output).not.toContain(secret);
  });

  it("reports registry denial instead of falling back to token publishing", () => {
    const result = runDiagnostic({ status: 404, message: "Trusted publisher not found" });
    expect(result.status).toBe(1);
    expect(result.output).toContain('HTTP 404; "Trusted publisher not found"');
  });

  it("redacts credentials echoed in a registry error and keeps multiline text escaped", () => {
    const result = runDiagnostic({ status: 403, message: `${requestToken} ${idToken}\n::warning::untrusted` });
    expect(result.status).toBe(1);
    expect(result.output).toContain("[redacted]");
    expect(result.output).not.toContain(requestToken);
    expect(result.output).not.toContain(idToken);
    expect(result.output).not.toContain("\n::warning::");
  });

  it.each([
    { noOidc: true }, { missingIdentity: true }, { missingCredential: true }, { redirect: true }
  ])("fails closed for incomplete authentication or redirects: %j", (options) => {
    const result = runDiagnostic(options);
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("trusted publishing accepted");
  });
});

describe("manual release recovery boundary", () => {
  function resolve(options: { ref?: string; tag?: string; publish?: boolean; latest?: string; prerelease?: boolean; draft?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "npm-recovery-test-"));
    const stub = `
      gh() {
        case "$2" in
          repos/OWNER/REPO) echo main ;;
          repos/OWNER/REPO/releases/latest) printf '%s' "$FIXTURE_LATEST" ;;
          repos/OWNER/REPO/releases/tags/*) printf '%s' "$FIXTURE_RELEASE" ;;
          *) return 1 ;;
        esac
      }
    `;
    try {
      return spawnSync("bash", ["-c", stub + resolver], {
        env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "OWNER/REPO",
          GITHUB_REF: options.ref ?? "refs/heads/main", RELEASE_TAG: options.tag ?? "v1.2.3",
          RECOVERY_PUBLISH: String(options.publish ?? false), RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, "output"),
          FIXTURE_LATEST: options.latest ?? "v1.2.3", FIXTURE_RELEASE: JSON.stringify({ tag_name: "v1.2.3", draft: options.draft ?? false, prerelease: options.prerelease ?? false, published_at: "2026-01-01T00:00:00Z" }) },
        encoding: "utf8", timeout: 5000
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts diagnostics and publishing of the latest published stable release", () => {
    expect(resolve().status).toBe(0);
    expect(resolve({ publish: true }).status).toBe(0);
  });

  it.each([
    { ref: "refs/heads/topic" }, { tag: "v1.2.3;echo unexpected" }, { tag: "v1.2.4" },
    { prerelease: true }, { draft: true }, { publish: true, latest: "v1.3.0" }
  ])("rejects an invalid release or recovery source: %j", (options) => {
    expect(resolve(options).status).not.toBe(0);
  });

  it("allows diagnostics for an older release without publishing it", () => {
    expect(resolve({ latest: "v1.3.0" }).status).toBe(0);
  });
});
