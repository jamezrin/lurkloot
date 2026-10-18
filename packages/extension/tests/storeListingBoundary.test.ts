import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { STORY_READINESS } from "../scripts/store-listing/capture.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING } from "../scripts/store-listing/lurkloot.mjs";

const storeListingDir = join(import.meta.dirname, "..", "scripts", "store-listing");
const coreDir = join(storeListingDir, "core");

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("store listing tooling boundary", () => {
  // The dashboard driver, browser session and sync loop are meant to be lifted
  // out of this repository one day. They only stay liftable while they receive
  // the product's choices as a listing profile instead of importing them.
  it("keeps core/ free of the product adapter and the rest of the repository", () => {
    const files = readdirSync(coreDir).filter((name) => name.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(join(coreDir, file), "utf8"));
      for (const specifier of specifiers) {
        const local = specifier.startsWith(".");
        const allowed = local
          ? !specifier.startsWith("..")
          : /^(node:|playwright$)/.test(specifier);
        expect(allowed, `core/${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("names the product nowhere in core/", () => {
    for (const file of readdirSync(coreDir).filter((name) => name.endsWith(".mjs"))) {
      const source = readFileSync(join(coreDir, file), "utf8");
      expect(source, `core/${file}`).not.toMatch(/lurkloot/i);
    }
  });

  it("has a readiness check for every story a screenshot variant renders", () => {
    for (const variant of LISTING.screenshots as { file: string; story: string }[]) {
      expect(
        STORY_READINESS[variant.story],
        `${variant.file} story ${variant.story}`,
      ).toBeDefined();
    }
  });
});
