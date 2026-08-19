import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { STORE_SCREENSHOT_VARIANTS, screenshotFilename, validateLocaleCodes } from "./store-screenshot-config.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validatePng(bytes, path) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${path} is not a PNG with an IHDR header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== 1280 || height !== 800) {
    throw new Error(`${path} is ${width}x${height}; expected 1280x800`);
  }
}

export async function validateStoreScreenshotFiles({ root, locales }) {
  validateLocaleCodes(locales);
  const expectedNames = new Set(STORE_SCREENSHOT_VARIANTS.map(screenshotFilename));
  const filesByLocale = new Map();

  for (const locale of locales) {
    const localeDirectory = join(root, locale);
    let entries;
    try {
      entries = await readdir(localeDirectory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not read screenshot directory for ${locale}: ${error.message}`);
    }
    const unexpected = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png") && !expectedNames.has(entry.name))
      .map((entry) => entry.name);
    if (unexpected.length > 0) {
      throw new Error(`Unexpected PNG files for ${locale}: ${unexpected.join(", ")}`);
    }

    const files = [];
    for (const variant of STORE_SCREENSHOT_VARIANTS) {
      const filename = screenshotFilename(variant);
      const path = join(localeDirectory, filename);
      let bytes;
      try {
        bytes = await readFile(path);
      } catch {
        throw new Error(`Missing expected screenshot for ${locale}: ${filename}`);
      }
      validatePng(bytes, path);
      files.push({ variant, path });
    }
    filesByLocale.set(locale, files);
  }

  return filesByLocale;
}
