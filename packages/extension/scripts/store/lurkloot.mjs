import { fileURLToPath } from "node:url";

// Everything about the Lurkloot listing that is not about uploading it. The
// generators here turn the built popup and the repository's own text into a
// bundle; @lurkloot/store-sync reads that bundle and knows nothing of this.

export const NAME = "lurkloot";

// The store's default language. The dashboard keeps its artwork in the shared
// "global" group and gives it no group of its own, so its screenshots and the
// promo tiles are generated for the bundle's global/ directory.
export const DEFAULT_LOCALE = "en";

// Listing languages, spelled as the extension package's _locales are.
export const LOCALES = Object.freeze([
  "en",
  "es",
  "fr",
  "it",
  "ru",
  "de",
  "zh_CN",
  "hi",
  "pt_BR",
  "ar",
  "tr",
  "ja",
  "id",
  "pl",
  "ko",
  "uk",
  "cs",
]);

// One screenshot per popup story, uploaded in this order.
export const SCREENSHOTS = Object.freeze([
  Object.freeze({ file: "01-drops", story: "queue" }),
  Object.freeze({ file: "02-extras", story: "games" }),
  Object.freeze({ file: "03-easy", story: "kick" }),
  Object.freeze({ file: "04-settings", story: "watchlist" }),
  Object.freeze({ file: "05-updated", story: "extensions" }),
]);

export const SCREENSHOT_SIZE = Object.freeze({ width: 1280, height: 800 });

// Anchored to this file rather than the working directory, so a command behaves
// the same whether pnpm or a person started it.
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export const PATHS = Object.freeze({
  packageRoot,
  build: `${packageRoot}.output/chrome-mv3`,
  // Ignored by git, so generating never leaves the tree dirty.
  bundle: `${packageRoot}artifacts/store`,
  descriptions: `${packageRoot}store-descriptions`,
});

export function validateLocales(requested) {
  const seen = new Set();
  for (const code of requested) {
    if (!LOCALES.includes(code)) {
      throw new Error(`Unknown locale ${code}. Known locales: ${LOCALES.join(", ")}`);
    }
    if (seen.has(code)) throw new Error(`Duplicate locale ${code}`);
    seen.add(code);
  }
  return [...requested];
}
