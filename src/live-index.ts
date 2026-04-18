import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildIndexLocked, loadIndex } from "./indexer.js";
import { getGitStateAsync, isCodexaGenerated, isCodexaInput } from "./git.js";
import { shouldSkipPath } from "./language.js";
import { discoverRepoFreshness } from "./repo-files.js";
import type { CodexaIndex } from "./types.js";
import { clamp, normalizePath, uniqueSorted } from "./util.js";

export interface LiveIndexOptions {
  debounceMs?: number;
  pollMs?: number;
  initial?: boolean;
  maxRuns?: number;
  signal?: AbortSignal;
  persistent?: boolean;
  watchFs?: boolean;
  onEvent?: (event: LiveIndexEvent) => void;
}

export type LiveIndexEvent =
  | { type: "watch-ready"; repoRoot: string; directories: number; pollMs: number; debounceMs: number }
  | { type: "change-detected"; repoRoot: string; reason: string }
  | { type: "index-start"; repoRoot: string; reason: string }
  | { type: "index-complete"; repoRoot: string; reason: string; files: number; symbols: number; usageSites: number; indexedAt: string; durationMs: number }
  | { type: "index-skip"; repoRoot: string; reason: string }
  | { type: "watch-warning"; repoRoot: string; message: string }
  | { type: "watch-stopped"; repoRoot: string; runs: number };

export interface LiveIndexRun {
  reason: string;
  files: number;
  symbols: number;
  usageSites: number;
  indexedAt: string;
  durationMs: number;
}

export interface LiveIndexSummary {
  repoRoot: string;
  runs: LiveIndexRun[];
  stopped: boolean;
}

interface ChangeSignature {
  signature: string;
  headCommit: string | null;
  dirtyFiles: string[];
  dirtyFileHashes: Record<string, string>;
}

export async function runLiveIndexer(repoInput: string, options: LiveIndexOptions = {}): Promise<LiveIndexSummary> {
  const repoRoot = path.resolve(repoInput);
  const debounceMs = clamp(options.debounceMs ?? 750, 50, 60_000);
  const pollMs = clamp(options.pollMs ?? 2_000, 250, 300_000);
  const maxRuns = options.maxRuns === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.maxRuns));
  const persistent = options.persistent ?? maxRuns === Number.POSITIVE_INFINITY;
  const onEvent = options.onEvent ?? (() => undefined);
  const runs: LiveIndexRun[] = [];
  const watchers: FSWatcher[] = [];
  let stopped = false;
  let building = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let pendingReasons = new Set<string>();
  let lastSignature = (await liveIndexSignatureFromLoadedIndex(repoRoot)) ?? (await liveIndexSignature(repoRoot));

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    for (const watcher of watchers) {
      watcher.close();
    }
    onEvent({ type: "watch-stopped", repoRoot, runs: runs.length });
  };

  const maybeStopAfterRun = () => {
    if (runs.length >= maxRuns) {
      stop();
    }
  };

  const rebuild = async (reason: string, force = false) => {
    if (stopped || building) {
      return;
    }
    const current = await liveIndexSignature(repoRoot);
    if (!force && current.signature === lastSignature.signature) {
      onEvent({ type: "index-skip", repoRoot, reason });
      return;
    }
    building = true;
    const startedAt = Date.now();
    onEvent({ type: "index-start", repoRoot, reason });
    try {
      const index = await buildIndexLocked({ repoRoot, writeArtifacts: true });
      const durationMs = Date.now() - startedAt;
      const run = summarizeRun(reason, index, durationMs);
      runs.push(run);
      lastSignature = signatureFromIndex(index);
      onEvent({ type: "index-complete", repoRoot, ...run });
      maybeStopAfterRun();
    } finally {
      building = false;
    }
  };

  const schedule = (reason: string) => {
    if (stopped) {
      return;
    }
    pendingReasons.add(reason);
    onEvent({ type: "change-detected", repoRoot, reason });
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const reasonText = uniqueSorted(pendingReasons).join("+") || "change";
      pendingReasons = new Set<string>();
      void rebuild(reasonText).catch((error) => {
        onEvent({ type: "watch-warning", repoRoot, message: error instanceof Error ? error.message : String(error) });
      });
    }, debounceMs);
  };

  if (options.initial ?? false) {
    await rebuild("initial", true);
    if (stopped) {
      return { repoRoot, runs, stopped };
    }
  }

  if (options.watchFs ?? true) {
    watchers.push(...(await openDirectoryWatchers(repoRoot, persistent, schedule, onEvent)));
  }
  pollTimer = setInterval(() => {
    void liveIndexSignature(repoRoot)
      .then((current) => {
        if (current.signature !== lastSignature.signature) {
          schedule("poll");
        }
      })
      .catch((error) => {
        onEvent({ type: "watch-warning", repoRoot, message: error instanceof Error ? error.message : String(error) });
      });
  }, pollMs);
  pollTimer.unref?.();
  onEvent({ type: "watch-ready", repoRoot, directories: watchers.length, pollMs, debounceMs });

  if (options.signal) {
    if (options.signal.aborted) {
      stop();
    } else {
      options.signal.addEventListener("abort", stop, { once: true });
    }
  }

  while (!stopped) {
    await delay(50);
  }
  return { repoRoot, runs, stopped };
}

export async function liveIndexSignature(repoRoot: string): Promise<ChangeSignature> {
  const freshness = await discoverRepoFreshness(repoRoot);
  const dirtyFiles = freshness.git.dirtyFiles.filter((file) => !isCodexaGenerated(file));
  const dirtyFileHashes = filterDirtyHashes(freshness.dirtyFileHashes, dirtyFiles);
  return changeSignature(freshness.git.headCommit, dirtyFiles, dirtyFileHashes);
}

async function liveIndexSignatureFromLoadedIndex(repoRoot: string): Promise<ChangeSignature | undefined> {
  const index = await loadIndex(repoRoot);
  return index ? signatureFromIndex(index) : undefined;
}

async function openDirectoryWatchers(
  repoRoot: string,
  persistent: boolean,
  schedule: (reason: string) => void,
  onEvent: (event: LiveIndexEvent) => void
): Promise<FSWatcher[]> {
  const directories = await watchedDirectories(repoRoot);
  const watchers: FSWatcher[] = [];
  for (const dir of directories) {
    const absoluteDir = path.join(repoRoot, dir);
    try {
      const watcher = watch(absoluteDir, { persistent }, (_eventType, filename) => {
        const relative = filename ? normalizePath(path.join(dir, filename.toString())) : dir;
        if (isIgnoredWatchPath(relative)) {
          return;
        }
        schedule("fs");
      });
      watcher.on("error", (error) => {
        onEvent({ type: "watch-warning", repoRoot, message: `watch ${dir}: ${error.message}` });
      });
      watchers.push(watcher);
    } catch (error) {
      onEvent({ type: "watch-warning", repoRoot, message: `watch ${dir}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return watchers;
}

async function watchedDirectories(repoRoot: string): Promise<string[]> {
  const git = await getGitStateAsync(repoRoot, { includeFiles: true, includeChurn: false });
  const directories = new Set<string>(["."]);
  for (const file of git.files) {
    const normalized = normalizePath(file);
    if (isIgnoredWatchPath(normalized)) {
      continue;
    }
    let dir = normalizePath(path.posix.dirname(normalized));
    while (dir && dir !== "." && !dir.startsWith("..")) {
      if (isIgnoredWatchPath(dir)) {
        break;
      }
      directories.add(dir);
      dir = normalizePath(path.posix.dirname(dir));
    }
  }
  return [...directories].sort((a, b) => a.localeCompare(b)).slice(0, 1024);
}

function isIgnoredWatchPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (isCodexaInput(normalized)) {
    return false;
  }
  return isCodexaGenerated(normalized) || shouldSkipPath(normalized);
}

function summarizeRun(reason: string, index: CodexaIndex, durationMs: number): LiveIndexRun {
  return {
    reason,
    files: index.files.length,
    symbols: index.symbols.length,
    usageSites: index.usageSites.length,
    indexedAt: index.freshness.indexedAt,
    durationMs
  };
}

function signatureFromIndex(index: CodexaIndex): ChangeSignature {
  const dirtyFiles = index.freshness.indexedDirtyFiles.filter((file) => !isCodexaGenerated(file));
  const dirtyFileHashes = filterDirtyHashes(index.freshness.indexedDirtyFileHashes ?? {}, dirtyFiles);
  return changeSignature(index.freshness.headCommit, dirtyFiles, dirtyFileHashes);
}

function filterDirtyHashes(hashes: Record<string, string>, dirtyFiles: string[]): Record<string, string> {
  const dirtySet = new Set(dirtyFiles);
  return Object.fromEntries(Object.entries(hashes).filter(([file]) => dirtySet.has(file)).sort(([a], [b]) => a.localeCompare(b)));
}

function changeSignature(headCommit: string | null, dirtyFiles: string[], dirtyFileHashes: Record<string, string>): ChangeSignature {
  const sortedDirtyFiles = uniqueSorted(dirtyFiles);
  const sortedDirtyFileHashes = filterDirtyHashes(dirtyFileHashes, sortedDirtyFiles);
  return {
    signature: JSON.stringify({
      headCommit,
      dirtyFiles: sortedDirtyFiles,
      dirtyFileHashes: sortedDirtyFileHashes
    }),
    headCommit,
    dirtyFiles: sortedDirtyFiles,
    dirtyFileHashes: sortedDirtyFileHashes
  };
}
