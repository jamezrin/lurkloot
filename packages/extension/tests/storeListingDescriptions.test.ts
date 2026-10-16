import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX_LENGTH,
  loadStoreDescriptions,
  parseStoreDescriptions,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing-descriptions.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { STORE_SCREENSHOT_LOCALES } from "../scripts/store-screenshot-config.mjs";

const localeCodes = (STORE_SCREENSHOT_LOCALES as { code: string }[]).map(({ code }) => code);

describe("store listing descriptions", () => {
  it("reads the detailed body of every section and stops at the rule", () => {
    const descriptions = parseStoreDescriptions(
      [
        "# Store listing descriptions",
        "",
        "## English (en)",
        "",
        "**Short:** One line.",
        "",
        "**Detailed:**",
        "",
        "First paragraph.",
        "",
        "Second paragraph.",
        "",
        "---",
        "",
        "Notes that are not part of the listing.",
        "",
        "## Turkish (tr)",
        "",
        "**Detailed:**",
        "Bir paragraf.",
      ].join("\n"),
    );

    expect([...descriptions]).toEqual([
      ["en", "First paragraph.\n\nSecond paragraph."],
      ["tr", "Bir paragraf."],
    ]);
  });

  it("rejects a locale listed twice", () => {
    expect(() =>
      parseStoreDescriptions("## A (en)\n**Detailed:**\nx\n## B (en)\n**Detailed:**\ny"),
    ).toThrow(/Duplicate store description for en/);
  });

  // The CLI syncs these bodies verbatim, so the real document is held to what
  // the dashboard will receive.
  it("has a plain-text description within the limit for every listing locale", async () => {
    const descriptions: Map<string, string> = await loadStoreDescriptions({
      locales: localeCodes,
    });

    expect([...descriptions.keys()]).toEqual(localeCodes);
    for (const [locale, description] of descriptions) {
      expect([...description].length, locale).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
      expect(description.split(/\n{2,}/).length, locale).toBeGreaterThanOrEqual(3);
      expect(description, locale).not.toMatch(/\*\*|^#|^---$|Short:|Detailed:/m);
    }
  });
});
