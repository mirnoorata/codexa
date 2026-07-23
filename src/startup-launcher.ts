import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isRecognizedNodeCommand } from "./init-portability.js";
import { nodeSupported } from "./node-version.js";

export type LauncherCommandValidation =
  | { state: "verified" }
  | { state: "unverified"; reason: string }
  | { state: "invalid"; reason: string };

export async function validateLauncherCommand(command: string): Promise<LauncherCommandValidation> {
  const nodeCommand = isRecognizedNodeCommand(command);
  const npxCommand = command === "npx" || command === "npx.cmd";
  let currentNode: string | undefined;
  if (nodeCommand || npxCommand) {
    try {
      currentNode = await realpath(process.execPath);
    } catch {
      return { state: "invalid", reason: "Codexa cannot resolve the current trusted Node runtime" };
    }
    if (!nodeSupported()) return { state: "invalid", reason: "Codexa is not running under a supported Node runtime" };
  }
  for (const candidate of executableCommandCandidates(command)) {
    try {
      const resolved = await realpath(candidate);
      const commandStat = await stat(resolved);
      if (!commandStat.isFile()) continue;
      await access(resolved, fsConstants.R_OK | fsConstants.X_OK);
      if (nodeCommand && currentNode && !sameResolvedExecutable(resolved, currentNode)) {
        if (path.isAbsolute(command)) {
          return {
            state: "invalid",
            reason: "Codexa-managed Node command is not the current trusted runtime; re-run codexa init"
          };
        }
        return {
          state: "unverified",
          reason: "Codexa-managed Node command resolves through a runtime shim that cannot be statically attested; strict readiness requires direct host-local wiring"
        };
      }
      if (npxCommand && currentNode && !(await npxCandidateBelongsToCurrentRuntime(resolved, currentNode))) {
        return {
          state: "unverified",
          reason: "Codexa-managed npx wrapper is not part of the current trusted Node installation; strict readiness requires trusted host-local wiring"
        };
      }
      return { state: "verified" };
    } catch {
      // Try the next PATH entry. The receipt reports only the aggregate failure.
    }
  }
  return { state: "invalid", reason: "Codexa-managed launcher command does not resolve to an executable file" };
}

async function npxCandidateBelongsToCurrentRuntime(resolvedCandidate: string, currentNode: string): Promise<boolean> {
  for (const trustedCandidate of trustedNpxCommandCandidates(currentNode)) {
    try {
      if (sameResolvedExecutable(await realpath(trustedCandidate), resolvedCandidate)) return true;
    } catch {
      // Missing installation layouts are simply not candidates for attestation.
    }
  }
  return false;
}

export function trustedNpxCommandCandidates(
  currentNode: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const nodeDirectory = pathApi.dirname(currentNode);
  if (platform === "win32") {
    return [
      pathApi.join(nodeDirectory, "npx.cmd"),
      pathApi.join(nodeDirectory, "npx.exe"),
      pathApi.join(nodeDirectory, "node_modules", "npm", "bin", "npx-cli.js")
    ];
  }
  const prefix = pathApi.dirname(nodeDirectory);
  return [
    pathApi.join(prefix, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    pathApi.join(prefix, "share", "nodejs", "npm", "bin", "npx-cli.js"),
    pathApi.join(nodeDirectory, "node_modules", "npm", "bin", "npx-cli.js")
  ];
}

function sameResolvedExecutable(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function executableCommandCandidates(
  command: string,
  searchPath = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.isAbsolute(command)) return [command];
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" && pathApi.extname(command) === ""
    ? pathExt.split(";").filter(Boolean).map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];
  return searchPath.split(delimiter).filter(Boolean).flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
}
