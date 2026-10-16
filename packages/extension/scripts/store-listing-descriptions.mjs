import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateLocaleCodes } from "./store-screenshot-config.mjs";

export const STORE_DESCRIPTIONS_PATH = fileURLToPath(
  new URL("../../../docs/store-descriptions.md", import.meta.url),
);

// The dashboard rejects a detailed description longer than this.
export const DESCRIPTION_MAX_LENGTH = 16_000;

const SECTION_HEADING = /^## .*\(([A-Za-z_]+)\)\s*$/;
const DETAILED_MARKER = /^\*\*Detailed:\*\*\s*$/;

// Each locale is a "## Language (code)" section whose "**Detailed:**" body
// runs until the next section or a "---" rule.
export function parseStoreDescriptions(markdown) {
  const descriptions = new Map();
  let locale;
  let body;
  const finish = () => {
    if (locale && body) descriptions.set(locale, body.join("\n").trim());
    body = undefined;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(SECTION_HEADING);
    if (heading) {
      finish();
      locale = heading[1];
      if (descriptions.has(locale)) throw new Error(`Duplicate store description for ${locale}`);
      continue;
    }
    if (line.startsWith("## ")) {
      finish();
      locale = undefined;
      continue;
    }
    if (!locale) continue;
    if (line.trim() === "---") {
      finish();
      locale = undefined;
      continue;
    }
    if (body) body.push(line);
    else if (DETAILED_MARKER.test(line)) body = [];
  }
  finish();
  return descriptions;
}

export async function loadStoreDescriptions({ locales, path = STORE_DESCRIPTIONS_PATH }) {
  validateLocaleCodes(locales);
  const all = parseStoreDescriptions(await readFile(path, "utf8"));
  const descriptions = new Map();
  for (const locale of locales) {
    const description = all.get(locale);
    if (!description) throw new Error(`Missing detailed store description for ${locale}`);
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
