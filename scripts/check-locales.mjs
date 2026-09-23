import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2] ?? fileURLToPath(new URL("../packages/locales/messages/", import.meta.url));

async function readCatalog(filename) {
  const catalog = JSON.parse(await readFile(join(directory, filename), "utf8"));
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`${filename} must contain a JSON object`);
  }
  return Object.keys(catalog);
}

try {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (!files.includes("en.json")) throw new Error("en.json is missing");

  const referenceKeys = new Set(await readCatalog("en.json"));
  let errors = 0;

  for (const file of files) {
    if (file === "en.json") continue;
    const keys = new Set(await readCatalog(file));
    const missing = [...referenceKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !referenceKeys.has(key));
    if (missing.length) {
      console.error(`${file}: missing keys: ${missing.join(", ")}`);
      errors += 1;
    }
    if (extra.length) {
      console.error(`${file}: extra keys: ${extra.join(", ")}`);
      errors += 1;
    }
  }

  if (errors) process.exitCode = 1;
  else console.log(`Locale keys match en.json in ${files.length} catalogs.`);
} catch (error) {
  console.error(`Locale key check failed: ${error.message}`);
  process.exitCode = 1;
}
