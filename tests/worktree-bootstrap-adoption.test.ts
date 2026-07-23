import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { currentAdoptionReceiptFacts } from "../src/worktree-bootstrap-adoption.js";

const fixtures: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("worktree bootstrap adoption integrity", () => {
  it("rejects a tree file whose pathname is replaced after its open handle is read", async () => {
    const repo = await createAdoptionFixture("codexa-adoption-replaced-path-");
    const target = path.join(repo, "dist/runtime.js");
    const replacement = path.join(repo, "replacement.js");
    const displaced = path.join(repo, "displaced.js");
    await writeFile(target, "original runtime\n", "utf8");
    await writeFile(replacement, "replacement runtime\n", "utf8");

    const originalOpen = nodeFs.open.bind(nodeFs);
    let swapped = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (path.resolve(String(file)) !== target) return handle;

      const originalStat = handle.stat.bind(handle);
      let statCalls = 0;
      Object.defineProperty(handle, "stat", {
        configurable: true,
        value: async () => {
          const entry = await originalStat();
          statCalls += 1;
          if (statCalls === 2) {
            await rename(target, displaced);
            await rename(replacement, target);
            swapped = true;
          }
          return entry;
        }
      });
      return handle;
    });

    await expect(currentAdoptionReceiptFacts(repo)).rejects.toThrow(
      /adoption-file-changed-during-scan/u
    );
    expect(swapped).toBe(true);
  });

  it("orders non-ASCII manifest entries without the process locale", async () => {
    const repo = await createAdoptionFixture("codexa-adoption-deterministic-order-");
    const dist = path.join(repo, "dist");
    await writeFile(path.join(dist, "z.js"), "z\n", "utf8");
    await writeFile(path.join(dist, "ä.js"), "umlaut\n", "utf8");

    const localeCompare = vi.spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale-sensitive manifest sort");
      });
    try {
      const facts = await currentAdoptionReceiptFacts(repo);
      const expected = createHash("sha256");
      for (const name of ["cli.js", "z.js", "ä.js"]) {
        const filePath = path.join(dist, name);
        const [entry, contents] = await Promise.all([
          lstat(filePath),
          readFile(filePath)
        ]);
        expected.update(
          `F\0${name}\0${(entry.mode & 0o777).toString(8)}\0${entry.size}\0`,
          "utf8"
        );
        expected.update(contents);
      }
      expect(facts.distRuntimeSha256).toBe(expected.digest("hex"));
    } finally {
      localeCompare.mockRestore();
    }
  });
});

async function createAdoptionFixture(prefix: string): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(repo);
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, "node_modules"), { recursive: true });
  await writeFile(path.join(repo, "dist/cli.js"), "export const cli = true;\n", "utf8");
  await writeFile(
    path.join(repo, "package-lock.json"),
    `${JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })}\n`,
    "utf8"
  );
  return repo;
}
