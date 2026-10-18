import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sectionId } from "@lurkloot/store-sync";
import { PATHS } from "../lurkloot.mjs";
import { stampGenerated } from "./sections.mjs";

export const descriptionSource = (paths, locale) => join(paths.descriptions, `${locale}.txt`);

// The descriptions are written by hand in store-descriptions/, so generating
// them means copying them into the bundle and stamping the copies. The version
// is the package's own: a description shows no build.
export async function generateDescriptions({ locales, paths = PATHS, output = console.log, env }) {
  const { version } = JSON.parse(await readFile(join(paths.packageRoot, "package.json"), "utf8"));
  const sections = [];
  for (const locale of locales) {
    await mkdir(join(paths.bundle, locale), { recursive: true });
    await copyFile(descriptionSource(paths, locale), join(paths.bundle, locale, "description.txt"));
    sections.push(sectionId(locale, "description"));
  }
  await stampGenerated({ bundle: paths.bundle, version, sections, env });
  output(`Stamped ${sections.length} descriptions.`);
}
