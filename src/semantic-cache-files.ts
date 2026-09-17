import fs from "node:fs";
import path from "node:path";

/** Preserve the synchronous options API while refusing redirected cache inputs. */
export function readSemanticCacheText(repoRoot: string, filePath: string, maxBytes: number): string {
  const root = fs.realpathSync(repoRoot);
  const relative = path.relative(path.resolve(repoRoot), filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("semantic cache path escapes repository");
  }
  const parts = relative.split(path.sep);
  let parent = root;
  const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const entry = fs.lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
      throw new Error("semantic cache directory is redirected or non-regular");
    }
    ancestors.push({ path: parent, dev: entry.dev, ino: entry.ino });
  }
  const target = path.join(parent, parts.at(-1)!);
  const before = fs.lstatSync(target);
  const regular = (entry: fs.Stats) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1;
  if (!regular(before) || before.size > maxBytes) throw new Error("semantic cache file is redirected, non-regular, or oversized");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!regular(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
      throw new Error("semantic cache file changed while opening");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    const after = fs.fstatSync(fd);
    if (!regular(after) || bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("semantic cache file changed while reading");
    }
    for (const ancestor of ancestors) {
      const current = fs.lstatSync(ancestor.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ancestor.dev || current.ino !== ancestor.ino || fs.realpathSync(ancestor.path) !== ancestor.path) {
        throw new Error("semantic cache directory changed while reading");
      }
    }
    const named = fs.lstatSync(target);
    if (!regular(named) || named.dev !== opened.dev || named.ino !== opened.ino || fs.realpathSync(repoRoot) !== root) {
      throw new Error("semantic cache path changed while reading");
    }
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
