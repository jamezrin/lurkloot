import { describe, expect, it } from "vitest";
import { commitRank } from "../../popup-ui/src/primitives";

describe("commitRank", () => {
  it("cancels empty, zero, and non-whole numbers", () => {
    for (const raw of ["", "  ", "0", "-1", "abc", "3.5", "3abc"]) {
      expect(commitRank(raw, 2, 12), raw).toEqual({ action: "cancel" });
    }
  });

  it("clamps a too-large rank to the last index", () => {
    expect(commitRank("99", 0, 12)).toEqual({ action: "move", toIndex: 11 });
  });

  it("accepts leading zeros as the integer they parse to", () => {
    expect(commitRank("03", 0, 12)).toEqual({ action: "move", toIndex: 2 });
  });

  it("moves to the typed 1-based position", () => {
    expect(commitRank("3", 0, 12)).toEqual({ action: "move", toIndex: 2 });
  });

  it("cancels when the typed rank is already the current position", () => {
    expect(commitRank("3", 2, 12)).toEqual({ action: "cancel" });
    expect(commitRank("99", 0, 1)).toEqual({ action: "cancel" });
  });
});
