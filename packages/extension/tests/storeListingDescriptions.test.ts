import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { loadStoreDescriptions } from "../scripts/store-listing/core/descriptions.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING, STORE_PATHS } from "../scripts/store-listing/lurkloot.mjs";

const localeCodes = (LISTING.locales as { code: string }[]).map(({ code }) => code);

describe("store descriptions", () => {
  it("has a description within the limit for every listing locale", async () => {
    const descriptions: Map<string, string> = await loadStoreDescriptions({
      locales: localeCodes,
      dir: STORE_PATHS.descriptions,
      listing: LISTING,
    });

    expect([...descriptions.keys()]).toEqual(localeCodes);
  });
});
