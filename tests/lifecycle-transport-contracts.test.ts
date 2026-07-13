import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli = path.resolve(process.cwd(), "dist/cli.js");

describe("lifecycle transport contracts", () => {
  it("keeps CLI lifecycle evidence options aligned with the MCP surface", () => {
    expect(help("change-plan")).toContain("--invariant <statement...>");
    expect(help("post-edit-review")).toContain("--invariant-review <json...>");
    expect(help("post-edit-review")).toContain("--artifact-id <id...>");
    expect(help("prove")).toContain("--artifact-id <id...>");
    expect(help("status")).toContain("--json");
    expect(help("verification-artifact")).toContain("--file <path>");
  });

  it("exposes state identity and verification artifacts through the built CLI", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-lifecycle-cli-repo-"));
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "codexa-lifecycle-cli-artifact-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(repo, "src/main.ts"), "export function main() { return 1; }\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Codexa", "-c", "user.email=codexa@example.invalid", "commit", "-m", "fixture"], {
        cwd: repo,
        stdio: "ignore"
      });

      expect(run(["index", repo], repo).status).toBe(0);
      const planned = run(
        [
          "change-plan",
          repo,
          "--task",
          "Keep the CLI lifecycle contract stable",
          "--file",
          "src/main.ts",
          "--save-snapshot",
          "--task-id",
          "cli-lifecycle-contract",
          "--invariant",
          "Do not change the exported function signature."
        ],
        repo
      );
      expect(planned.status).toBe(0);

      const status = run(["status", repo, "--json"], repo);
      expect(status.status).toBe(0);
      const statusData = JSON.parse(status.stdout) as {
        mode?: string;
        repoRoot?: string;
        headCommit?: string | null;
        stale?: boolean;
        workspaceStateDigest?: string;
      };
      expect(statusData).toMatchObject({ mode: "freshness", repoRoot: repo, stale: false });
      expect(statusData.headCommit).toMatch(/^[a-f0-9]{40}$/u);
      expect(statusData.workspaceStateDigest).toMatch(/^[a-f0-9]{64}$/u);

      const manifestPath = path.join(sourceDir, "summary.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 1,
          kind: "codexa-verification-summary",
          binding: {
            taskId: "cli-lifecycle-contract",
            headCommit: statusData.headCommit,
            workspaceStateDigest: statusData.workspaceStateDigest
          },
          run: { id: "cli-run-1", category: "integration", outcome: "passed", durationMs: 10 },
          checks: [{ kind: "workflow", target: "cli-smoke", outcome: "passed", summary: "CLI smoke passed" }],
          producer: { name: "fixture-runner", version: "1" }
        }),
        "utf8"
      );

      const ingested = run(["verification-artifact", repo, "--file", manifestPath, "--json"], repo);
      expect(ingested.status).toBe(0);
      const artifact = JSON.parse(ingested.stdout) as {
        created?: boolean;
        record?: { artifactId?: string; manifest?: { binding?: { taskId?: string } } };
      };
      expect(artifact.created).toBe(true);
      expect(artifact.record?.artifactId).toMatch(/^va_[a-f0-9]{64}$/u);
      expect(artifact.record?.manifest?.binding?.taskId).toBe("cli-lifecycle-contract");

      const proof = run(
        ["prove", repo, "--task-id", "cli-lifecycle-contract", "--artifact-id", artifact.record?.artifactId ?? "", "--json"],
        repo
      );
      expect(proof.status).toBe(0);
      const proofData = JSON.parse(proof.stdout) as {
        verification?: { artifacts?: { selected?: Array<{ artifactId?: string; status?: string; trustTier?: string }> } };
      };
      expect(proofData.verification?.artifacts?.selected).toContainEqual(
        expect.objectContaining({ artifactId: artifact.record?.artifactId, status: "accepted", trustTier: "reported" })
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function help(command: string): string {
  const result = run([command, "--help"], process.cwd());
  expect(result.status).toBe(0);
  return result.stdout;
}

function run(args: string[], cwd: string): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CODEXA_AUTOVERIFY: "0" }
  }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}
