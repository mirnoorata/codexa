export type ShellControlOperator = "start" | "&&" | "||" | "|" | ";" | "&";
export type ShellTruthiness = "true" | "false" | "unknown";

export function splitShellSequence(command: string): Array<{ text: string; operator: ShellControlOperator }> {
  const segments: Array<{ text: string; operator: ShellControlOperator }> = [];
  let quote: "'" | '"' | undefined;
  let current = "";
  let operator: ShellControlOperator = "start";
  command = stripCommentsAndHeredocs(command);
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if ((char === "'" || char === '"') && command[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      current += char;
      continue;
    }
    if (!quote && ((char === "&" && next === "&") || (char === "|" && next === "|"))) {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      } else if (operator === "&") {
        // A pending background marker must survive a following separator
        // (`cmd &\n`): flush it before the operator is overwritten, or the
        // backgrounded runner would lose its masking.
        segments.push({ text: "", operator });
      }
      operator = char === "&" ? "&&" : "||";
      current = "";
      index += 1;
      continue;
    }
    // A bare `&` backgrounds the preceding command, decoupling its exit code, in
    // every position EXCEPT a redirection — like a real shell, `cmd&next` and
    // `cmd&` background `cmd` regardless of surrounding whitespace. It is not a
    // background only for `2>&1`/`>&2` (prev is `<`/`>`/`&`), `&>file` (next is
    // `>`), the `&&` form (handled above), or an escaped `\&` (prev is `\`).
    // Unquoted newlines terminate a command just like `;`.
    const prev = command[index - 1];
    const backgroundAmp = char === "&" && prev !== undefined && !/[<>&\\]/u.test(prev) && next !== ">";
    if (!quote && (char === "|" || char === ";" || char === "\n" || char === "\r" || backgroundAmp)) {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      } else if (operator === "&" && char !== "&") {
        segments.push({ text: "", operator });
      } else if ((char === "\n" || char === "\r") && (operator === "&&" || operator === "||" || operator === "|")) {
        // Line continuation: `cmd &&\n next` — the newline does not terminate
        // the command; the pending operator still binds the next segment.
        continue;
      }
      operator = char === "|" ? "|" : char === "&" ? "&" : ";";
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push({ text: current.trim(), operator });
  } else if (operator === "&") {
    // Trailing `&` (e.g. `npm test &`) — preserve the background marker so
    // callers can see the preceding runner's exit was decoupled.
    segments.push({ text: "", operator });
  }
  return segments;
}

// Strip what a tokenizer must not mistake for commands: unquoted `#` comments
// (to end of line) and heredoc BODIES (`cat <<EOF ... EOF`). Both are removed
// in a single source-order pass so a `<<WORD` hidden inside a comment is never
// read as a real marker, and a comment can never absorb a pending operator.
// Quoting and `$(( ))` arithmetic are tracked so `2>&1`-style content, `||#`
// glued comments, `${#var}`, and `$((1 << 2))` are handled correctly. Dropped
// text only ever reduces credit (fail closed). Newlines are preserved as
// separators/continuations for the caller.
function stripCommentsAndHeredocs(command: string): string {
  if (!command.includes("#") && !command.includes("<<")) {
    return command;
  }
  let out = "";
  let quote: "'" | '"' | undefined;
  let pos = 0;
  while (pos < command.length) {
    const newline = command.indexOf("\n", pos);
    const hasNewline = newline !== -1;
    const lineEnd = hasNewline ? newline : command.length;
    const scanned = scanShellLine(command.slice(pos, lineEnd), quote);
    quote = scanned.quote;
    out += scanned.kept;
    if (hasNewline) {
      out += "\n";
    }
    pos = lineEnd + (hasNewline ? 1 : 0);
    // Drop the body of each heredoc opened on this line, in order (`cmd <<A <<B`
    // reads body A then body B). The delimiter line ends the body — leading tabs
    // are stripped only for the `<<-` form, matching bash.
    for (const marker of scanned.markers) {
      while (pos < command.length) {
        const bodyEnd = command.indexOf("\n", pos);
        const hasBody = bodyEnd !== -1;
        const bodyLine = command.slice(pos, hasBody ? bodyEnd : command.length).replace(/\r$/u, "");
        pos = (hasBody ? bodyEnd : command.length) + (hasBody ? 1 : 0);
        if ((marker.dash ? bodyLine.replace(/^\t+/u, "") : bodyLine) === marker.delimiter) {
          break;
        }
        if (!hasBody) {
          break;
        }
      }
    }
  }
  return out;
}

function scanShellLine(line: string, quoteIn: "'" | '"' | undefined): { kept: string; quote: "'" | '"' | undefined; markers: Array<{ delimiter: string; dash: boolean }> } {
  let kept = "";
  let quote = quoteIn;
  let arithParens = 0;
  const markers: Array<{ delimiter: string; dash: boolean }> = [];
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      kept += char;
      if (char === quote && line[i - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      kept += char;
      continue;
    }
    // A `#` only starts a comment at a word boundary (start, whitespace, or an
    // operator) — not inside `file#1` or `${X#pat}`.
    if (char === "#" && (i === 0 || /[\s;|&]/u.test(line[i - 1]))) {
      break;
    }
    if (char === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      arithParens += 2;
      kept += "$((";
      i += 2;
      continue;
    }
    if (arithParens > 0) {
      if (char === "(") {
        arithParens += 1;
      } else if (char === ")") {
        arithParens -= 1;
      }
      kept += char;
      continue;
    }
    if (char === "<" && line[i + 1] === "<") {
      if (line[i + 2] === "<") {
        kept += "<<<";
        i += 2;
        continue;
      }
      // Match the FULL bash delimiter word (any run of non-blank shell-word
      // chars: `EOF`, `EOF-1`, `EOF.txt`, digit-led `1-2`), so the body
      // terminates only on an exact full-word line — capturing just a `\w+`
      // prefix would end the body early and re-expose its data as commands.
      // Arithmetic `$((1 << 2))` is already consumed above, so this cannot
      // misfire on a shift.
      const marker = /^<<(-?)[ \t]*(['"]?)([^\s'"`<>|&;()]+)\2/u.exec(line.slice(i));
      if (marker) {
        markers.push({ delimiter: marker[3], dash: marker[1] === "-" });
        kept += marker[0];
        i += marker[0].length - 1;
        continue;
      }
    }
    kept += char;
  }
  return { kept, quote, markers };
}

// Remove `$(...)` (depth-tracked) and backtick command-substitution spans that
// are not single-quoted literals. A command inside a substitution never directly
// decides the script's exit, so name-credit matching must not see it; the text
// outside substitutions is returned intact. Follows shell quoting: `'` is a
// literal inside double quotes (an apostrophe must not flip quote state), `"`
// is a literal inside single quotes, substitutions still expand inside double
// quotes, and quotes inside a substitution shield its parens from depth
// counting. Unbalanced spans strip to the end (fail closed: less text to match
// means less credit).
export function stripCommandSubstitutions(command: string): string {
  return scanCommandSubstitutions(command).outside;
}

// The text INSIDE `$(...)`/backtick substitutions — what a script discards when
// a non-running carrier wraps them. Callers use it to ask whether the discarded
// command looks like a named check.
export function commandSubstitutionContents(command: string): string {
  return scanCommandSubstitutions(command).inside;
}

// Each removed substitution leaves a sentinel token in the outside text so
// stripping can never glue two surrounding words into a phrase that was not in
// the command (`vite $(X) build` must not fabricate a `vite build` match).
const SUBSTITUTION_SENTINEL = "__codexa_substitution__";

function scanCommandSubstitutions(command: string): { outside: string; inside: string } {
  let outside = "";
  let inside = "";
  let quote: "'" | '"' | undefined;
  let outerQuote: "'" | '"' | undefined;
  let backtick = false;
  let depth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (depth === 0 && !backtick) {
        outside += char + (command[index + 1] ?? "");
      } else {
        inside += char + (command[index + 1] ?? "");
      }
      index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && (quote === undefined || quote === char)) {
      quote = quote === char ? undefined : char;
      if (depth === 0 && !backtick) {
        outside += char;
      } else {
        inside += char;
      }
      continue;
    }
    if (quote === "'") {
      if (depth === 0 && !backtick) {
        outside += char;
      } else {
        inside += char;
      }
      continue;
    }
    if (char === "`") {
      backtick = !backtick;
      if (!backtick) {
        outside += SUBSTITUTION_SENTINEL;
        inside += "\n";
      }
      continue;
    }
    if (backtick) {
      inside += char;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      if (depth === 0) {
        // The substitution opens a fresh quoting context; remember the outer
        // double-quote state so it resumes when the substitution closes.
        outerQuote = quote;
        quote = undefined;
      }
      depth += 1;
      index += 1;
      continue;
    }
    if (depth > 0) {
      if (quote === undefined) {
        if (char === "(") {
          depth += 1;
        } else if (char === ")") {
          depth -= 1;
          if (depth === 0) {
            quote = outerQuote;
            outside += SUBSTITUTION_SENTINEL;
            inside += "\n";
            continue;
          }
        }
      }
      inside += char;
      continue;
    }
    outside += char;
  }
  if (depth > 0 || backtick) {
    // Unbalanced span stripped to the end — still mark that one was here.
    outside += SUBSTITUTION_SENTINEL;
  }
  return { outside, inside };
}

// True when single/double quotes in a command string are balanced. The word
// tokenizer cannot represent nested quoting, so a doubly shell-wrapped command
// unwraps to a mangled, unbalanced inner string whose masking operators are lost
// on re-tokenization; callers treat an unbalanced result as unverifiable.
export function hasBalancedQuotes(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    }
  }
  return quote === undefined;
}

export function segmentTruthiness(segment: string): ShellTruthiness {
  const words = stripShellControlWords(stripLeadingEnvironment(shellWords(segment)));
  const first = words[0];
  if (first === "true" || first === ":") {
    return "true";
  }
  if (first === "false") {
    return "false";
  }
  if (first === "exit" && words[1]) {
    const code = Number.parseInt(words[1], 10);
    if (Number.isFinite(code)) {
      return code === 0 ? "true" : "false";
    }
  }
  return "unknown";
}

export function shellWords(value: string): string[] {
  return [...value.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map((match) => stripQuotes(match[1] ?? match[2] ?? match[3] ?? ""));
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/gu, "");
}

export function isNonRunningCommand(words: string[]): boolean {
  return words[0] === "echo" || words[0] === "printf";
}

export function shellWrappedCommand(words: string[]): string | undefined {
  const first = words[0];
  if (first !== "bash" && first !== "sh" && first !== "zsh") {
    return undefined;
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-c" || word === "-lc" || word === "-cl" || (word.startsWith("-") && word.includes("c"))) {
      return words[index + 1];
    }
  }
  return undefined;
}

// True when a shell wrapper's `-c` body could not be cleanly isolated. A
// well-formed `sh -c "<body>"` keeps the whole body in one token, so any extra
// tokens after it mean the tokenizer split a body containing escaped/nested
// quotes it cannot represent (e.g. `bash -lc "npm test --grep \"x\" || true"`).
// The extracted body is then a truncated prefix that silently drops a trailing
// mask, so callers must fail closed instead of analyzing it.
export function shellWrapperBodyIsAmbiguous(words: string[]): boolean {
  const first = words[0];
  if (first !== "bash" && first !== "sh" && first !== "zsh") {
    return false;
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-c" || word === "-lc" || word === "-cl" || (word.startsWith("-") && word.includes("c"))) {
      return index + 2 < words.length;
    }
  }
  return false;
}

export function hasNonRunningJavaScriptTestArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-v", "-V", "--help", "-h", "help"].includes(arg));
}

export function hasNonRunningPythonTestArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-V", "--help", "-h", "help"].includes(arg));
}

export function hasNonRunningCommandArg(args: string[]): boolean {
  return args.some((arg) => ["--version", "-v", "-V", "--help", "-h", "help"].includes(arg));
}

export function stripPackageManagerFlags(words: string[]): string[] {
  const first = words[0];
  if (first !== "npm" && first !== "pnpm" && first !== "yarn") {
    return words;
  }
  const noValueFlags = new Set(["--silent", "-s", "--no-progress", "--color", "--no-color"]);
  const valueFlags = new Set(["--loglevel", "--userconfig", "--cache"]);
  const stripped = [first];
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (noValueFlags.has(word) || /^--(?:color|no-color|silent|no-progress)=/u.test(word)) {
      index += 1;
      continue;
    }
    if (valueFlags.has(word) && words[index + 1]) {
      index += 2;
      continue;
    }
    if (flagValue(word, [...valueFlags])) {
      index += 1;
      continue;
    }
    break;
  }
  return [...stripped, ...words.slice(index)];
}

export function hasPnpmWorkspaceFlag(words: string[]): boolean {
  return words.some((word) => word === "-r" || word === "recursive" || word === "--recursive" || word === "--filter" || word === "-F" || word.startsWith("--filter=") || word.startsWith("-F="));
}

export function stripLeadingEnvironment(words: string[]): string[] {
  let index = 0;
  if (words[index] === "env") {
    index += 1;
    while (index < words.length && (words[index] === "-i" || words[index] === "--ignore-environment")) {
      index += 1;
    }
  }
  while (index < words.length && isEnvironmentAssignment(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

export function stripShellControlWords(words: string[]): string[] {
  let index = 0;
  while (words[index] === "then" || words[index] === "do") {
    index += 1;
  }
  return words.slice(index);
}

export function isEnvironmentAssignment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value));
}

function flagValue(word: string | undefined, flags: string[]): string | undefined {
  if (!word) {
    return undefined;
  }
  for (const flag of flags) {
    if (word.startsWith(`${flag}=`)) {
      return word.slice(flag.length + 1);
    }
  }
  return undefined;
}
