// Package-script credit gating: what can a script body vouch for? Two evidence
// channels with distinct falsifiers — NAME trust (a script called "typecheck"
// is believed to typecheck) fails when the body's exit cannot reflect the named
// check; TOOL evidence (a runner visible in command position of the
// substitution-stripped body) fails when the token is not actually an
// invocation. Both channels resolve commands identically (resolveToolInvocation)
// so they cannot drift — drift between them caused real laundering bugs.
import {
  commandSubstitutionContents,
  shellWords,
  shellWrappedCommand,
  shellWrapperBodyIsAmbiguous,
  splitShellSequence,
  stripCommandSubstitutions,
  stripLeadingEnvironment,
  stripPackageManagerFlags,
  stripShellControlWords
} from "./shell.js";
import { EXIT_CONSUMING_OPENERS, segmentMasksExit, stripFlowPrefix } from "./masking.js";

// Prefixes that run their argument as the command without changing its exit
// semantics — `command echo`, `exec echo`, `nohup echo`, `timeout 5 echo` all
// still run echo. A leading backslash (`\echo`) only suppresses alias lookup,
// and brace-group/subshell openers (`{ echo ...`, `(echo ...`) propagate the
// inner command's behavior.
const TRANSPARENT_EXEC_PREFIXES = new Set(["command", "builtin", "busybox", "exec", "nohup", "nice", "time", "sudo", "doas", "stdbuf", "timeout", "env"]);

// Resolve the effective command word through the transparent prefixes above,
// skipping their flags and duration arguments, group openers, and backslashes.
function resolveCommandIndex(words: string[]): { word: string | undefined; index: number } {
  let index = 0;
  let sawPrefix = false;
  while (index < words.length) {
    const word = words[index].replace(/^[({\\]+/u, "");
    if (word === "" || TRANSPARENT_EXEC_PREFIXES.has(word)) {
      sawPrefix = true;
      index += 1;
      continue;
    }
    if (sawPrefix && (word.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/u.test(word))) {
      index += 1;
      continue;
    }
    return { word, index };
  }
  return { word: undefined, index };
}

// Launchers that expose the next word as the real tool (`npx tsc`).
const TOOL_LAUNCHERS = new Set(["npx", "bunx"]);
const PACKAGE_MANAGER_EXEC_WORDS = new Set(["exec", "x", "dlx"]);
// Launcher flags that take a value (`npx -p typescript tsc`).
const LAUNCHER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

function skipLauncherFlags(args: string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (LAUNCHER_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return args.slice(index);
}

function commandBasename(word: string): string {
  return (word.replace(/^[({\\]+/u, "").replace(/[)}]+$/u, "").split("/").pop() ?? "").toLowerCase();
}

// The single command-resolution path for BOTH credit channels: transparent
// prefixes, then npx/bunx and pm exec/x/dlx launchers (with their flags), down
// to the tool that actually runs. The name-veto and the evidence extractor
// must agree on what a command is — they once didn't, and the drift laundered
// `npx -y tsc --version` into a credited typecheck.
function resolveToolInvocation(words: string[]): { command: string; args: string[] } {
  const { index } = resolveCommandIndex(words);
  let command = commandBasename(words[index] ?? "");
  let args = words.slice(index + 1);
  if (TOOL_LAUNCHERS.has(command) || ((command === "npm" || command === "pnpm" || command === "yarn") && PACKAGE_MANAGER_EXEC_WORDS.has(args[0] ?? ""))) {
    const rest = skipLauncherFlags(TOOL_LAUNCHERS.has(command) ? args : args.slice(1));
    command = commandBasename(rest[0] ?? "");
    args = rest.slice(1);
  }
  return { command, args };
}

// True when a script body's exit does NOT faithfully reflect its named check, so
// the name-based credit (script "build" => build coverage) would launder a
// masked failure into a pass. Unsafe when a later segment masks an earlier
// runner, a compound opener consumes the runner's exit, a `!` negation inverts
// it, or a shell wrapper's recursively-unwrapped body is itself unsafe or could
// not be cleanly tokenized. A clean wrapper such as `sh -c "vite build"` — or a
// runner that merely takes a substitution as an argument (`vite build --define
// X=$(git rev-parse HEAD)`) — stays safe.
export function scriptNameCreditUnsafe(command: string): boolean {
  const segments = splitShellSequence(command);
  if (segments.slice(1).some(segmentMasksExit)) {
    return true;
  }
  return segments.some((segment) => {
    const words = stripLeadingEnvironment(shellWords(segment.text));
    // Resolve through group openers so `( if tsc; then :; fi )` is still seen
    // as an exit-consuming compound.
    const first = stripFlowPrefix(words)[0];
    if (first !== undefined && (first.startsWith("!") || EXIT_CONSUMING_OPENERS.has(first) || first.startsWith("$(") || first.startsWith("`"))) {
      return true;
    }
    const wrapped = shellWrappedCommand(words);
    return wrapped !== undefined && (shellWrapperBodyIsAmbiguous(words) || scriptNameCreditUnsafe(wrapped));
  });
}

// Commands a script name could plausibly be vouching for. A carrier-discarded
// substitution containing one of these means the named check itself was run
// and its exit thrown away; a substitution holding only metadata commands
// (`date`, `git rev-parse`) does not poison the name. Any package-manager
// invocation counts — `yarn build`, `pnpm run lint`, `npx tsc` — since those
// are exactly how named checks are launched.
const DISCARDED_CHECK_PATTERN = /\b(tsc|vitest|jest|pytest|eslint|biome|verify-source-hygiene|verify-public-hygiene)\b|\b(vite|next)\s+build\b|\b(?:npm|pnpm|yarn|npx|bun|bunx)\s+\S|\bnode\s+--test\b/u;

// A substitution carried by ANY command is exit-discarded — `echo $(tsc)`,
// `export X=$(tsc)`, and `git commit -m "$(tsc)"` all throw the inner exit
// away. The only propagating form is a bare assignment (`X=$(tsc)` — the
// assignment's exit IS the substitution's), which stripLeadingEnvironment
// consumes entirely, leaving no command word.
function commandDiscardedSubstitution(segment: { text: string }): boolean {
  const first = resolveCommandIndex(stripLeadingEnvironment(shellWords(segment.text))).word;
  return first !== undefined && stripCommandSubstitutions(segment.text) !== segment.text;
}

// True when the script NAME alone cannot be trusted as evidence: somewhere in
// the body a command discards the exit of a substitution that LOOKS like the
// named check (`echo $(tsc)`, `export X=$(tsc) && echo passed`, `git commit -m
// "$(tsc)"`, or the same inside a wrapper). The discarded check never
// contributes an exit-faithful result no matter what ends the chain, so the
// name proves nothing about it. A substitution holding only metadata
// (`node build.mjs && echo $(date)`) does not poison the name, and tool
// evidence on the substitution-stripped body is unaffected either way — a
// runner visible outside substitutions keeps its own credit.
export function scriptNameTrustUnsafe(command: string): boolean {
  return splitShellSequence(command).some((segment) => {
    if (commandDiscardedSubstitution(segment) && DISCARDED_CHECK_PATTERN.test(commandSubstitutionContents(segment.text))) {
      return true;
    }
    const words = stripLeadingEnvironment(shellWords(segment.text));
    const wrapped = shellWrappedCommand(words);
    return wrapped !== undefined && (shellWrapperBodyIsAmbiguous(words) || scriptNameTrustUnsafe(wrapped));
  });
}

export const NON_COMPILING_TSC_FLAG = /^(--help|-h|--version|-v|--init|--all|--showConfig|--listFilesOnly)$/u;

// True when a tsc invocation only prints info and does not typecheck, so it must
// not satisfy a TypeScript verification check.
export function isNonCompilingTscCommand(words: string[]): boolean {
  const { command, args } = resolveToolInvocation(stripPackageManagerFlags(words));
  if (command !== "tsc") {
    return false;
  }
  return args.some((arg) => NON_COMPILING_TSC_FLAG.test(arg.replace(/[)}]+$/u, "")));
}

// True when a package-script body that would otherwise count as a TypeScript
// check is actually a non-compiling tsc invocation (e.g. "tsc --help") —
// including one hidden inside a shell wrapper (`sh -c 'tsc --help'`).
export function scriptBodyIsNonCompilingTsc(scriptCommand: string): boolean {
  return splitShellSequence(scriptCommand).some((segment) => {
    const words = stripLeadingEnvironment(shellWords(segment.text));
    const wrapped = shellWrappedCommand(words);
    if (wrapped !== undefined) {
      return !shellWrapperBodyIsAmbiguous(words) && scriptBodyIsNonCompilingTsc(wrapped);
    }
    return isNonCompilingTscCommand(words);
  });
}

export interface ScriptToolEvidence {
  tscCompile: boolean;
  tscNoEmit: boolean;
  bundlerBuild: boolean;
  lint: boolean;
  privacy: boolean;
  audit: boolean;
}

// Tool evidence from command-position tokens of the substitution-stripped body
// — never a substring scan, so paths (`scripts/run-tsc.mjs`), env-var names
// (`TSC=1`), and prose cannot masquerade as invocations, while
// `./node_modules/.bin/tsc` still counts via its basename.
export function scriptToolEvidence(strippedCommand: string): ScriptToolEvidence {
  const evidence: ScriptToolEvidence = { tscCompile: false, tscNoEmit: false, bundlerBuild: false, lint: false, privacy: false, audit: false };
  collectToolEvidence(strippedCommand, evidence);
  return evidence;
}

function collectToolEvidence(strippedCommand: string, evidence: ScriptToolEvidence): void {
  for (const segment of splitShellSequence(strippedCommand)) {
    const words = stripPackageManagerFlags(stripShellControlWords(stripLeadingEnvironment(shellWords(segment.text))));
    const wrapped = shellWrappedCommand(words);
    if (wrapped !== undefined) {
      if (!shellWrapperBodyIsAmbiguous(words)) {
        collectToolEvidence(wrapped, evidence);
      }
      continue;
    }
    const { command, args } = resolveToolInvocation(words);
    recordToolEvidence(command, args, evidence);
    if ((command === "node" || command === "bash" || command === "sh") && !invocationIsInformational(args)) {
      for (const arg of args) {
        recordVerifyScriptEvidence(commandBasename(arg), evidence);
      }
    }
  }
}

// True for invocations that only print info (`--help`, `--version`) and so
// run nothing they could vouch for. Args are normalized for glued group
// closers (`(tsc --noEmit)` leaves `--noEmit)`).
function invocationIsInformational(args: string[]): boolean {
  return args.some((arg) => {
    const flag = arg.replace(/[)}]+$/u, "");
    return NON_COMPILING_TSC_FLAG.test(flag) || flag === "help";
  });
}

function recordToolEvidence(command: string, args: string[], evidence: ScriptToolEvidence): void {
  if (invocationIsInformational(args)) {
    return;
  }
  const flags = args.map((arg) => arg.replace(/[)}]+$/u, ""));
  if (command === "tsc") {
    if (flags.some((flag) => flag === "--noEmit" || flag === "--noemit")) {
      evidence.tscNoEmit = true;
    } else {
      evidence.tscCompile = true;
    }
  }
  if ((command === "vite" || command === "next") && flags[0] === "build") {
    evidence.bundlerBuild = true;
  }
  if (command === "eslint" || command === "biome") {
    evidence.lint = true;
  }
  if ((command === "npm" || command === "pnpm") && flags[0] === "audit") {
    evidence.audit = true;
  }
  recordVerifyScriptEvidence(command, evidence);
}

function recordVerifyScriptEvidence(basename: string, evidence: ScriptToolEvidence): void {
  if (basename.startsWith("verify-source-hygiene")) {
    evidence.lint = true;
  }
  if (basename.startsWith("verify-public-hygiene")) {
    evidence.privacy = true;
  }
}
