import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  currentAdoptionReceiptFacts,
  readBoundedStableRegularFile
} from "../src/worktree-bootstrap-adoption.js";

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

  it("rejects a dist entry added after the dist tree was enumerated", async () => {
    const repo = await createAdoptionFixture("codexa-adoption-dist-entry-race-");
    const dependencyRoot = path.join(repo, "node_modules");
    const injected = path.join(repo, "dist/injected.js");
    const originalOpendir = nodeFs.opendir.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "opendir").mockImplementation(async (directory, options) => {
      const handle = await originalOpendir(directory, options);
      if (path.resolve(String(directory)) !== dependencyRoot) return handle;

      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: async () => {
          const entry = await originalRead();
          if (entry === null && !mutated) {
            await writeFile(injected, "injected after dist enumeration\n", "utf8");
            mutated = true;
          }
          return entry;
        }
      });
      return handle;
    });

    await expect(currentAdoptionReceiptFacts(repo)).rejects.toThrow(
      /dist-runtime-directory-changed-during-scan/u
    );
    expect(mutated).toBe(true);
  });

  it("rejects a dependency entry removed after its subtree was hashed", async () => {
    const repo = await createAdoptionFixture("codexa-adoption-dependency-entry-race-");
    const earlyDirectory = path.join(repo, "node_modules/a-package");
    const removed = path.join(earlyDirectory, "index.js");
    const trigger = path.join(repo, "node_modules/z-trigger.js");
    await mkdir(earlyDirectory);
    await writeFile(removed, "early dependency\n", "utf8");
    await writeFile(trigger, "late dependency\n", "utf8");

    const originalOpen = nodeFs.open.bind(nodeFs);
    let mutated = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!mutated && path.resolve(String(file)) === trigger) {
        await rm(removed);
        mutated = true;
      }
      return originalOpen(file, flags, mode);
    });

    await expect(currentAdoptionReceiptFacts(repo)).rejects.toThrow(
      /dependency-inventory-directory-changed-during-scan/u
    );
    expect(mutated).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a regular file replaced by a FIFO before open without blocking",
    async () => {
      const repo = await createAdoptionFixture("codexa-adoption-fifo-open-race-");
      const target = path.join(repo, "dist/cli.js");
      const originalOpen = nodeFs.open.bind(nodeFs);
      let swapped = false;
      vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
        if (!swapped && path.resolve(String(file)) === target) {
          await rm(target);
          execFileSync("mkfifo", [target]);
          swapped = true;
        }
        return originalOpen(file, flags, mode);
      });

      await expect(readBoundedStableRegularFile(
        target,
        1024,
        "fifo-race",
        Date.now() + 1_000,
        repo
      )).rejects.toThrow(/fifo-race-changed-during-read/u);
      expect(swapped).toBe(true);
    }
  );

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
