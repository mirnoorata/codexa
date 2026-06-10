export type ShellControlOperator = "start" | "&&" | "||" | "|" | ";";
export type ShellTruthiness = "true" | "false" | "unknown";

export function splitShellSequence(command: string): Array<{ text: string; operator: ShellControlOperator }> {
  const segments: Array<{ text: string; operator: ShellControlOperator }> = [];
  let quote: "'" | '"' | undefined;
  let current = "";
  let operator: ShellControlOperator = "start";
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
      }
      operator = char === "&" ? "&&" : "||";
      current = "";
      index += 1;
      continue;
    }
    if (!quote && char === "|") {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      }
      operator = "|";
      current = "";
      continue;
    }
    if (!quote && char === ";") {
      if (current.trim()) {
        segments.push({ text: current.trim(), operator });
      }
      operator = ";";
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push({ text: current.trim(), operator });
  }
  return segments;
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
