import { describe, expect, it } from "vitest";
import { isSourcePath, languageForPath } from "../src/language.js";
import type { LanguageId } from "../src/types.js";

const FILE_ONLY_LANGUAGE_PATHS: Array<[string, LanguageId]> = [
  ["src/App.cs", "csharp"],
  ["src/main.c", "c"],
  ["include/main.h", "c"],
  ["src/main.cc", "cpp"],
  ["src/main.cpp", "cpp"],
  ["src/main.cxx", "cpp"],
  ["include/main.hpp", "cpp"],
  ["include/main.hh", "cpp"],
  ["include/main.hxx", "cpp"],
  ["lib/app.rb", "ruby"],
  ["src/app.php", "php"]
];

describe("language source classification", () => {
  it.each(FILE_ONLY_LANGUAGE_PATHS)("indexes recognized file-only path %s as %s", (filePath, language) => {
    expect(languageForPath(filePath)).toBe(language);
    expect(isSourcePath(filePath)).toBe(true);
  });

  it("does not turn an unrecognized extension into a source path", () => {
    expect(languageForPath("src/App.kt")).toBe("unknown");
    expect(isSourcePath("src/App.kt")).toBe(false);
  });
});
