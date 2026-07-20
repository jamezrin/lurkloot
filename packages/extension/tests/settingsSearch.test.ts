import { describe, expect, it } from "vitest";
import { matchesSearch, normalizeSearchText } from "../../popup-ui/src/settingsSearch";

describe("normalizeSearchText", () => {
  it("lowercases, trims and folds diacritics", () => {
    expect(normalizeSearchText("  Margen DE Seguridad  ")).toBe("margen de seguridad");
    expect(normalizeSearchText("Sicherheitsmarge")).toBe("sicherheitsmarge");
    expect(normalizeSearchText("Marge de sécurité")).toBe("marge de securite");
  });

  it("leaves non-latin scripts intact", () => {
    expect(normalizeSearchText("安全边际")).toBe("安全边际");
  });
});

describe("matchesSearch", () => {
  const haystack = ["Deadline safety margin", "Extra buffer minutes before a reward deadline."];

  it("matches an empty query", () => {
    expect(matchesSearch(haystack, "")).toBe(true);
    expect(matchesSearch(haystack, "   ")).toBe(true);
  });

  it("matches a single token in the title", () => {
    expect(matchesSearch(haystack, "deadline")).toBe(true);
  });

  it("matches a token in the description", () => {
    expect(matchesSearch(haystack, "buffer")).toBe(true);
  });

  it("requires every token to match, in any order or field", () => {
    expect(matchesSearch(haystack, "safety margin")).toBe(true);
    expect(matchesSearch(haystack, "margin safety")).toBe(true);
    expect(matchesSearch(haystack, "margin buffer")).toBe(true);
    expect(matchesSearch(haystack, "safety unrelated")).toBe(false);
  });

  it("ignores accents in the query", () => {
    expect(matchesSearch(["Marge de sécurité"], "securite")).toBe(true);
    expect(matchesSearch(["Marge de securite"], "sécurité")).toBe(true);
  });

  it("does not match on substrings of the query", () => {
    expect(matchesSearch(haystack, "deadlines")).toBe(false);
  });
});
