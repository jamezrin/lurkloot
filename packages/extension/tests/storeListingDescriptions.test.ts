import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { loadStoreDescriptions } from "../scripts/store-listing/core/descriptions.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { STORE_SCREENSHOT_LOCALES } from "../scripts/store-listing/lurkloot.mjs";

const localeCodes = (STORE_SCREENSHOT_LOCALES as { code: string }[]).map(({ code }) => code);

describe("store descriptions", () => {
  it("has a description within the limit for every listing locale", async () => {
    const descriptions: Map<string, string> = await loadStoreDescriptions({
      locales: localeCodes,
    });

    expect([...descriptions.keys()]).toEqual(localeCodes);
  });
});
