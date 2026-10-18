// What a producer needs: lay files out as a bundle, stamp what you wrote, and
// say where it came from. Everything else in this package is the consumer.
export {
  BUNDLE_MANIFEST,
  DESCRIPTION_MAX_LENGTH,
  GLOBAL,
  MAX_SCREENSHOTS,
  PARTS,
  PROMO_TILES,
  SCREENSHOT_SIZES,
  readBundle,
  sectionId,
  sectionPath,
  stampBundle,
} from "./bundle.mjs";
export { gitProvenance } from "./provenance.mjs";
export { isLocaleCode } from "./locales.mjs";
