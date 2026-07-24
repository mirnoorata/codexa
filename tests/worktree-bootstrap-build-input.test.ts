import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { worktreeBootstrapBuildInputSnapshot } from "../src/worktree-bootstrap-build-input.js";

const fixtures: string[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap build-input snapshot", () => {
  it("revalidates retained source state after later scope work", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "codexa-build-input-snapshot-"));
    fixtures.push(repo);
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(repo, "package-lock.json"), "{}\n", "utf8");
    await writeFile(path.join(repo, "tsconfig.json"), "{}\n", "utf8");
    const source = path.join(repo, "src/index.ts");
    await writeFile(source, "export const value = 1;\n", "utf8");

    const snapshot = await worktreeBootstrapBuildInputSnapshot(repo);
    await writeFile(source, "export const value = 2;\n", "utf8");

    await expect(snapshot.revalidate()).rejects.toThrow(
      /build-input-entry-changed-during-scan/u
    );
  });
});
