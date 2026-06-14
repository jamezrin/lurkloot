import { describe, expect, it } from "vitest";
import { isMinorOrMajorBump } from "../src/core/version";

describe("isMinorOrMajorBump", () => {
  it("is false for a patch-only bump", () => {
    expect(isMinorOrMajorBump("1.3.0", "1.3.1")).toBe(false);
    expect(isMinorOrMajorBump("1.3.5", "1.3.12")).toBe(false);
  });

  it("is true for a minor bump", () => {
    expect(isMinorOrMajorBump("1.3.0", "1.4.0")).toBe(true);
    expect(isMinorOrMajorBump("1.3.7", "1.4.0")).toBe(true);
  });

  it("is true for a major bump", () => {
    expect(isMinorOrMajorBump("1.3.0", "2.0.0")).toBe(true);
    expect(isMinorOrMajorBump("1.9.9", "2.0.0")).toBe(true);
  });

  it("is false for equal versions", () => {
    expect(isMinorOrMajorBump("1.3.0", "1.3.0")).toBe(false);
  });

  it("is false for a downgrade", () => {
    expect(isMinorOrMajorBump("1.4.0", "1.3.0")).toBe(false);
    expect(isMinorOrMajorBump("2.0.0", "1.9.9")).toBe(false);
  });

  it("is false for malformed or missing input", () => {
    expect(isMinorOrMajorBump(undefined, "1.4.0")).toBe(false);
    expect(isMinorOrMajorBump("1.3.0", undefined)).toBe(false);
    expect(isMinorOrMajorBump("", "1.4.0")).toBe(false);
    expect(isMinorOrMajorBump("not.a.version", "1.4.0")).toBe(false);
    expect(isMinorOrMajorBump("1", "2")).toBe(true);
  });
});
