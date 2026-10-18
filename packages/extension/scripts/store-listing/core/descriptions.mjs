import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLocaleCodes } from "../lurkloot.mjs";

export const STORE_DESCRIPTIONS_DIR = fileURLToPath(
  new URL("../../../store-descriptions", import.meta.url),
);

// The dashboard rejects a detailed description longer than this.
export const DESCRIPTION_MAX_LENGTH = 16_000;

export async function loadStoreDescriptions({ locales, dir = STORE_DESCRIPTIONS_DIR }) {
  validateLocaleCodes(locales);
  const descriptions = new Map();
  for (const locale of locales) {
    const description = (await readFile(join(dir, `${locale}.txt`), "utf8")).trim();
    if (!description) throw new Error(`Store description for ${locale} is empty`);
    const length = [...description].length;
    if (length > DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `Store description for ${locale} is ${length} characters; the limit is ${DESCRIPTION_MAX_LENGTH}`,
      );
    }
    descriptions.set(locale, description);
  }
  return descriptions;
}
