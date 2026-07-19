import { promises as fs } from "node:fs";
import path from "node:path";

export async function readContextSnippet(
  repoRoot: string,
  filePath: string,
  centerLine: number,
  radius: number
): Promise<{ text: string } | { unreadable: string }> {
  try {
    const source = await fs.readFile(path.join(repoRoot, filePath), "utf8");
    const lines = source.split(/\r?\n/u);
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    const text = lines
      .slice(start - 1, end)
      .map((line, index) => `  ${String(start + index).padStart(4, " ")} | ${line.slice(0, 180)}`)
      .join("\n");
    return { text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { unreadable: typeof code === "string" ? code : "ERR" };
  }
}
