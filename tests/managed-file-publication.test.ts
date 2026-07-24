import { promises as nodeFs } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishManagedStateFile } from "../src/managed-file-publication.js";

const fixtures: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(
    (fixture) => rm(fixture, { recursive: true, force: true })
  ));
});

describe("managed file publication", () => {
  it("atomically replaces a stable managed file", async () => {
    const repo = await fixture("codexa-managed-publish-");
    await mkdir(path.join(repo, ".codex/tmp"), { recursive: true });
    const destination = path.join(repo, ".codex/tmp/receipt.json");
    await writeFile(destination, "old\n");

    await expect(publishManagedStateFile(
      repo,
      ["tmp"],
      "receipt.json",
      "new\n",
      "receipt-publication"
    )).resolves.toBe(destination);
    await expect(readFile(destination, "utf8")).resolves.toBe("new\n");
  });

  it("does not overwrite or remove an outside destination after a parent swap", async () => {
    const repo = await fixture("codexa-managed-publish-race-");
    const outside = await fixture("codexa-managed-publish-race-target-");
    const directory = path.join(repo, ".codex/tmp");
    const displaced = path.join(repo, ".codex/tmp-displaced");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "receipt.json"), "inside-old\n");
    await writeFile(path.join(outside, "receipt.json"), "outside-sentinel\n");
    const originalOpen = nodeFs.open.bind(nodeFs);
    let swapped = false;
    vi.spyOn(nodeFs, "open").mockImplementation(async (file, flags, mode) => {
      if (!swapped && path.basename(String(file)).startsWith(".receipt.json.")) {
        swapped = true;
        await rename(directory, displaced);
        await symlink(outside, directory, "dir");
      }
      return originalOpen(file, flags, mode);
    });

    try {
      await expect(publishManagedStateFile(
        repo,
        ["tmp"],
        "receipt.json",
        "new-receipt\n",
        "receipt-publication"
      )).rejects.toThrow(
        /receipt-publication-directory-(?:invalid|changed-during-publication)/u
      );
      await expect(readFile(path.join(outside, "receipt.json"), "utf8")).resolves.toBe(
        "outside-sentinel\n"
      );
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
      await rename(displaced, directory);
    }
    expect(swapped).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the final rename anchored when the named parent is swapped",
    async () => {
      const repo = await fixture("codexa-managed-publish-rename-race-");
      const outside = await fixture("codexa-managed-publish-rename-target-");
      const directory = path.join(repo, ".codex/tmp");
      const displaced = path.join(repo, ".codex/tmp-displaced");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "receipt.json"), "inside-old\n");
      await writeFile(path.join(outside, "receipt.json"), "outside-sentinel\n");
      const originalRename = nodeFs.rename.bind(nodeFs);
      let swapped = false;
      let outsideTemporary = "";
      vi.spyOn(nodeFs, "rename").mockImplementation(async (oldPath, newPath) => {
        if (
          !swapped &&
          path.basename(String(oldPath)).startsWith(".receipt.json.") &&
          path.basename(String(newPath)) === "receipt.json"
        ) {
          swapped = true;
          outsideTemporary = path.join(outside, path.basename(String(oldPath)));
          await writeFile(outsideTemporary, "outside-temporary-sentinel\n");
          await originalRename(directory, displaced);
          await symlink(outside, directory, "dir");
        }
        return originalRename(oldPath, newPath);
      });

      try {
        await expect(publishManagedStateFile(
          repo,
          ["tmp"],
          "receipt.json",
          "new-receipt\n",
          "receipt-publication"
        )).rejects.toThrow(
          /receipt-publication-directory-(?:invalid|changed-during-publication)/u
        );
        await expect(readFile(path.join(outside, "receipt.json"), "utf8")).resolves.toBe(
          "outside-sentinel\n"
        );
        await expect(readFile(outsideTemporary, "utf8")).resolves.toBe(
          "outside-temporary-sentinel\n"
        );
        await expect(readFile(path.join(displaced, "receipt.json"), "utf8")).resolves.toBe(
          "new-receipt\n"
        );
      } finally {
        vi.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
        await originalRename(displaced, directory);
      }
      expect(swapped).toBe(true);
    }
  );
});

async function fixture(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}
