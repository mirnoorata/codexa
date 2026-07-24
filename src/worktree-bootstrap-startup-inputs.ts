import path from "node:path";

const STARTUP_DECLARATION_MAX_COUNT = 64;
const STARTUP_DECLARATION_MAX_NAME_BYTES = 32 * 1024;

export function parseBootstrapInputNames(wrapper: string): string[] {
  const prefix = "# focus-worktree-bootstrap-input: ";
  const names: string[] = [];
  const seen = new Set<string>();
  let nameBytes = 0;
  let lineStart = 0;
  while (lineStart <= wrapper.length) {
    const newline = wrapper.indexOf("\n", lineStart);
    let lineEnd = newline === -1 ? wrapper.length : newline;
    if (
      newline !== -1 &&
      lineEnd > lineStart &&
      wrapper.charCodeAt(lineEnd - 1) === 13
    ) {
      lineEnd -= 1;
    }
    if (
      lineEnd - lineStart >= prefix.length &&
      wrapper.startsWith(prefix, lineStart)
    ) {
      const nameStart = lineStart + prefix.length;
      const nameLength = lineEnd - nameStart;
      if (
        names.length >= STARTUP_DECLARATION_MAX_COUNT ||
        nameLength > STARTUP_DECLARATION_MAX_NAME_BYTES
      ) {
        throw new Error("bootstrap-input-declarations-invalid");
      }
      const name = wrapper.slice(nameStart, lineEnd);
      nameBytes += Buffer.byteLength(name, "utf8");
      if (
        nameBytes > STARTUP_DECLARATION_MAX_NAME_BYTES ||
        seen.has(name)
      ) {
        throw new Error("bootstrap-input-declarations-invalid");
      }
      names.push(name);
      seen.add(name);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (names.length === 0) {
    throw new Error("bootstrap-input-declarations-invalid");
  }
  for (const name of names) {
    if (
      name.length === 0 ||
      name.length > 512 ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      path.posix.normalize(name) !== name ||
      name.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error("bootstrap-input-declarations-invalid");
    }
  }
  return names;
}
