import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEXA_VERSION } from "../src/version.js";

describe("Codexa GitHub Action", () => {
  it("is a read-only composite wrapper around the packaged shared receipt", async () => {
    const action = await readFile(path.resolve("action.yml"), "utf8");
    expect(action).toContain("using: composite");
    expect(action).toContain("CODEXA_INPUT_BASE: ${{ inputs.base }}");
    expect(action).toContain("CODEXA_INPUT_HEAD: ${{ inputs.head }}");
    expect(action).toContain('args=(review "$GITHUB_WORKSPACE"');
    expect(action).toContain('runtime_dir="$(mktemp -d "$RUNNER_TEMP/codexa-action.XXXXXX")"');
    expect(action).toContain('cd "$runtime_dir"');
    expect(action).toContain('npx --yes --package "@mirnoorata/codexa@${version}" codexa "${args[@]}"');
    expect(action).toContain("--format github");
    expect(action).not.toMatch(/pull-requests:\s*write|issues:\s*write|gh\s+pr\s+comment|github-script/u);

    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string; files: string[] };
    expect(packageJson.version).toBe(CODEXA_VERSION);
    expect(packageJson.files).toContain("action.yml");
  });
});
