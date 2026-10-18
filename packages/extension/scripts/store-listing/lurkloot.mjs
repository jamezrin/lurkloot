import { fileURLToPath } from "node:url";
import { defineListing } from "./core/listing.mjs";

// Everything specific to the Lurkloot listing lives here. The generic tooling
// in core/ receives this profile and never imports it.

// Each variant names the popup story the capture renders for it.
export const STORE_SCREENSHOT_VARIANTS = Object.freeze([
  Object.freeze({ id: "drops", file: "01-drops", story: "queue" }),
  Object.freeze({ id: "extras", file: "02-extras", story: "games" }),
  Object.freeze({ id: "easy", file: "03-easy", story: "kick" }),
  Object.freeze({ id: "settings", file: "04-settings", story: "watchlist" }),
  Object.freeze({ id: "updated", file: "05-updated", story: "extensions" }),
]);

export const STORE_SCREENSHOT_LOCALES = Object.freeze([
  Object.freeze({ code: "en", dashboardLabel: "English" }),
  Object.freeze({ code: "es", dashboardLabel: "Spanish" }),
  Object.freeze({ code: "fr", dashboardLabel: "French" }),
  Object.freeze({ code: "it", dashboardLabel: "Italian" }),
  Object.freeze({ code: "ru", dashboardLabel: "Russian" }),
  Object.freeze({ code: "de", dashboardLabel: "German" }),
  Object.freeze({ code: "zh_CN", dashboardLabel: "Chinese (China)" }),
  Object.freeze({ code: "hi", dashboardLabel: "Hindi" }),
  Object.freeze({ code: "pt_BR", dashboardLabel: "Portuguese (Brazil)" }),
  Object.freeze({ code: "ar", dashboardLabel: "Arabic" }),
  Object.freeze({ code: "tr", dashboardLabel: "Turkish" }),
  Object.freeze({ code: "ja", dashboardLabel: "Japanese" }),
  Object.freeze({ code: "id", dashboardLabel: "Indonesian" }),
  Object.freeze({ code: "pl", dashboardLabel: "Polish" }),
  Object.freeze({ code: "ko", dashboardLabel: "Korean" }),
  Object.freeze({ code: "uk", dashboardLabel: "Ukrainian" }),
  Object.freeze({ code: "cs", dashboardLabel: "Czech" }),
]);

export const LISTING = defineListing({
  name: "lurkloot",
  locales: STORE_SCREENSHOT_LOCALES,
  screenshots: STORE_SCREENSHOT_VARIANTS,
  screenshotSize: { width: 1280, height: 800 },
  // The shared "Global screenshots" group shows the English artwork.
  globalScreenshotsFrom: "en",
  profileApp: "lurkloot",
  command: "pnpm cws:listing",
});

// Anchored to this file rather than the working directory, so a stage behaves
// the same whether pnpm or a person started it.
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export const STORE_PATHS = Object.freeze({
  packageRoot,
  build: `${packageRoot}.output/chrome-mv3`,
  screenshots: `${packageRoot}artifacts/store-screenshots`,
  promos: `${packageRoot}artifacts/store-promo`,
  descriptions: `${packageRoot}store-descriptions`,
});
