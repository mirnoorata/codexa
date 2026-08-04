import { describe, expect, it } from "vitest";
import { assertIndexArtifactSize } from "../src/indexer/artifact-writing.js";

describe("index artifact size parity", () => {
  it("accepts the loader ceiling and rejects output that would be unreadable", () => {
    expect(() => assertIndexArtifactSize("1234", 4)).not.toThrow();
    expect(() => assertIndexArtifactSize("12345", 4)).toThrow(
      "Codexa index artifact is 5 bytes; maximum supported size is 4 bytes"
    );
    expect(() => assertIndexArtifactSize("é", 1)).toThrow(
      "Codexa index artifact is 2 bytes; maximum supported size is 1 byte"
    );
  });
});
