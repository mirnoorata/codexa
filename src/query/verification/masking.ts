// Shell exit-masking semantics: when does a reported exit 0 prove a runner
// passed? A runner's exit can be overridden by a later command (`|| true`,
// `; echo done`), decoupled by backgrounding (`&`) or a pipe, or consumed by a
// compound (`if RUNNER; ...`). These predicates are pure string/token logic
// shared by the coverage analyzer and the script-credit gate.
import { segmentTruthiness, shellWords, shellWrappedCommand, splitShellSequence, stripLeadingEnvironment, type ShellControlOperator } from "./shell.js";

// Shell operators that can decouple/override a preceding command's exit code,
// so a reported exit 0 no longer proves that command (a runner) passed. `&&` is
// absent: it preserves all-must-pass semantics.
const COVERAGE_MASKING_OPERATORS = new Set<ShellControlOperator>(["||", ";", "|", "&"]);

// Shell keywords that terminate control-flow syntax rather than run a command;
// a `;` before one of these (e.g. `if true; then npm test; fi`) is grammar, not
// an exit-overriding command, so it must not be treated as masking. A brace
// group OPENER is deliberately absent: `runner; { anything; }` is a real
// exit-overriding command group (`false; { echo done; }` exits 0), while the
// closing `}` of the runner's own group propagates and stays exempt.
const SHELL_FLOW_KEYWORDS = new Set(["fi", "then", "else", "elif", "do", "done", "esac", ";;", "}"]);

// True when `later` (a segment after a runner) can override the runner's exit
// code. Backgrounding (`&`) always decouples; for `||`/`;`/`|`, only a real
// following command overrides (not empty/whitespace or a shell flow keyword).
export function segmentMasksExit(later: { text: string; operator: ShellControlOperator }): boolean {
  if (!COVERAGE_MASKING_OPERATORS.has(later.operator)) {
    return false;
  }
  if (later.operator === "&") {
    return true;
  }
  const words = stripLeadingEnvironment(shellWords(later.text));
  // A group opener heading the later segment (`{ echo done` / `(echo done`)
  // wraps a real command — resolve to it so the group is not mistaken for
  // grammar. A standalone glued closer (`fi)` from a wrapped compound) is
  // still grammar, so strip its trailing closers before the keyword test.
  let firstWord = words[0];
  if (firstWord !== undefined) {
    const inner = firstWord.replace(/^[({]+/u, "");
    firstWord = inner === "" ? words[1] : inner;
    if (firstWord !== undefined && words.length === 1) {
      firstWord = firstWord.replace(/[)}]+$/u, "");
    }
  }
  if (!firstWord || SHELL_FLOW_KEYWORDS.has(firstWord)) {
    return false;
  }
  // `A || B` only masks A's failure if B can exit 0. A known-false fallback
  // (`|| false`, `|| exit 1`) re-raises the failure, so A stays exit-faithful
  // and must keep its coverage. (`;` and `|` always decouple, regardless of B.)
  if (later.operator === "||" && segmentTruthiness(later.text) === "false") {
    return false;
  }
  return true;
}

// True when the reported-envelope fast path must defer to the full per-segment
// analyzer. We defer when a top-level segment carries an exit-masking operator
// OR is a shell wrapper (`sh -c "..."`): a wrapper can hide a masking operator
// inside its quoted body that this top-level scan cannot see, so only the
// unwrapping per-segment analyzer can classify it safely.
export function commandNeedsFullMaskingAnalysis(command: string): boolean {
  return splitShellSequence(command).some(
    (segment) =>
      COVERAGE_MASKING_OPERATORS.has(segment.operator) ||
      shellWrappedCommand(stripLeadingEnvironment(shellWords(segment.text))) !== undefined
  );
}

// Shell compound openers that decouple the script's exit from the commands
// inside them — `if RUNNER; then ...; fi` exits 0 whether or not RUNNER passed,
// a non-matching `case`/empty `for` exits 0 without running its body at all.
// (Subshells `(...)` and brace groups `{ ...; }` propagate the inner exit, so
// they are deliberately absent.)
export const EXIT_CONSUMING_OPENERS = new Set(["if", "elif", "while", "until", "for", "select", "case"]);

// Leading shell flow keywords that can precede a nested compound opener on the
// same `;`-separated segment (`then if b`, `do for x`, `else if c`). Group
// openers (`{ if ...`, `( while ...` — standalone or glued) are equally
// transparent: the compound keyword behind them must still be detected.
const FLOW_PREFIX_WORDS = new Set(["then", "do", "else"]);

export function stripFlowPrefix(words: string[]): string[] {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index].replace(/^[({]+/u, "");
    if (word === "" || FLOW_PREFIX_WORDS.has(word)) {
      continue;
    }
    return [word, ...words.slice(index + 1)];
  }
  return [];
}
