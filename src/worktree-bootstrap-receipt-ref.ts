import { runCommand } from "./command.js";

export const WORKTREE_BOOTSTRAP_RECEIPT_REF = "refs/worktree/codexa/bootstrap-receipt";

const RECEIPT_MAX_BYTES = 128 * 1024;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;

export async function publishWorktreeReceiptRef(
  repoRoot: string,
  contents: string
): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > RECEIPT_MAX_BYTES) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-too-large");
  }
  const stored = await runCommand(
    "git",
    ["-C", repoRoot, "hash-object", "-w", "--stdin"],
    {
      input: contents,
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024,
      killProcessGroup: false
    }
  );
  const objectId = stored.stdout.trim();
  if (!stored.ok || !GIT_OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-object-publication-failed");
  }
  const published = await runCommand(
    "git",
    ["-C", repoRoot, "update-ref", "--no-deref", WORKTREE_BOOTSTRAP_RECEIPT_REF, objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024,
      killProcessGroup: false
    }
  );
  if (!published.ok) {
    throw new Error("Cannot issue Codexa worktree receipt: receipt-ref-publication-failed");
  }
}

export async function readWorktreeReceiptRef(
  repoRoot: string
): Promise<
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "ok"; contents: string }
> {
  const resolved = await runCommand(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", WORKTREE_BOOTSTRAP_RECEIPT_REF],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024,
      killProcessGroup: false
    }
  );
  if (!resolved.ok) {
    if (resolved.timedOut || resolved.truncated || resolved.error) {
      return { state: "invalid", reason: "receipt-ref-resolution-failed" };
    }
    return { state: "missing" };
  }
  const objectId = resolved.stdout.trim();
  if (!GIT_OBJECT_ID_PATTERN.test(objectId)) {
    return { state: "invalid", reason: "receipt-ref-object-invalid" };
  }
  const type = await runCommand(
    "git",
    ["-C", repoRoot, "cat-file", "-t", objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: 64 * 1024,
      killProcessGroup: false
    }
  );
  if (!type.ok || type.stdout.trim() !== "blob") {
    return { state: "invalid", reason: "receipt-ref-object-invalid" };
  }
  const contents = await runCommand(
    "git",
    ["-C", repoRoot, "cat-file", "blob", objectId],
    {
      timeoutMs: 2_500,
      maxBufferBytes: RECEIPT_MAX_BYTES + 1,
      killProcessGroup: false
    }
  );
  if (
    contents.truncated ||
    Buffer.byteLength(contents.stdout, "utf8") > RECEIPT_MAX_BYTES
  ) {
    return { state: "invalid", reason: "receipt-too-large" };
  }
  if (!contents.ok) {
    return { state: "invalid", reason: "receipt-object-read-failed" };
  }
  return { state: "ok", contents: contents.stdout };
}
