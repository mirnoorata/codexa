import path from "node:path";
import { readBoundedStableRegularFile } from "./worktree-bootstrap-adoption.js";

const SESSION_START_FILE_READ_TIMEOUT_MS = 1_000;
const SESSION_START_CONFIG_MAX_BYTES = 1024 * 1024;
const SESSION_START_PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const SESSION_START_FOCUS_FILE_MAX_BYTES = 2 * 1024 * 1024;

export async function readSessionStartConfig(
  configPath: string,
  repoRoot: string
): Promise<string> {
  try {
    return (await readSessionStartFile(
      configPath,
      SESSION_START_CONFIG_MAX_BYTES,
      "session-start-config",
      repoRoot
    )).toString("utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function readSessionStartPackageJson(packageRoot: string): Promise<string> {
  return (await readSessionStartFile(
    path.join(packageRoot, "package.json"),
    SESSION_START_PACKAGE_JSON_MAX_BYTES,
    "codexa-package-json",
    packageRoot
  )).toString("utf8");
}

export async function readSessionStartFocusFile(filePath: string): Promise<string> {
  return (await readSessionStartFile(
    filePath,
    SESSION_START_FOCUS_FILE_MAX_BYTES,
    "workspace-focus-file"
  )).toString("utf8");
}

function readSessionStartFile(
  filePath: string,
  maxBytes: number,
  label: string,
  containmentRoot?: string
): Promise<Buffer> {
  return readBoundedStableRegularFile(
    filePath,
    maxBytes,
    label,
    Date.now() + SESSION_START_FILE_READ_TIMEOUT_MS,
    containmentRoot
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
