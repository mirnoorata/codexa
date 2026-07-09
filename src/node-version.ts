import path from "node:path";

export const MIN_NODE_MAJOR = 22;

export function nodeMajor(version: string = process.versions.node): number {
  return Number(version.split(".")[0]);
}

export function nodeSupported(version: string = process.versions.node): boolean {
  const major = nodeMajor(version);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

// The exact interpreter running this process, when it looks like a real node
// binary that can be pinned into host-local wiring. Anything unexpected
// (bundlers, custom launchers) falls back to PATH-dependent "node".
export function pinnableNodeExecPath(): string | null {
  const execPath = process.execPath;
  if (!execPath || !path.isAbsolute(execPath)) {
    return null;
  }
  return /^node(?:js)?(?:\.exe)?$/iu.test(path.basename(execPath)) ? execPath : null;
}

export function nodeVersionComplaint(): string {
  return `Node ${process.version} at ${process.execPath} is below Codexa's >=${MIN_NODE_MAJOR} requirement. Launch with a supported node (e.g. \`nvm use ${MIN_NODE_MAJOR}\`) and re-run \`codexa init\` so generated wiring pins that binary.`;
}
