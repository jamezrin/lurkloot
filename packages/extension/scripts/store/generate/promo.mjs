import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { GLOBAL, PROMO_TILES, sectionId } from "@lurkloot/store-sync";
import { DEFAULT_LOCALE, PATHS } from "../lurkloot.mjs";
import { withPopup } from "./popup.mjs";
import { installSection, resetStaging, stagingPath, stampGenerated } from "./sections.mjs";

const execFileAsync = promisify(execFile);

// The dashboard has one pair of promo tiles for the whole listing, so they are
// generated once, from the default language, into global/promo.
export async function generatePromo({ paths = PATHS, output = console.log, env }) {
  await resetStaging(paths.bundle);
  const dir = stagingPath(paths.bundle, GLOBAL, "promo");
  const version = await withPopup(paths.build, async ({ page, origin, popupPath, version }) => {
    for (const [name, { width, height }] of Object.entries(PROMO_TILES)) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `${origin}${popupPath}?screenshot=promo&format=${name}&locale=${DEFAULT_LOCALE}`,
        { waitUntil: "networkidle" },
      );
      await page.waitForSelector("[data-store-promo]");
      await page.evaluate(() => document.fonts.ready);
      const file = join(dir, `${name}.png`);
      await page.screenshot({ path: file, omitBackground: false });
      // The store takes 24-bit PNGs with no alpha channel.
      await execFileAsync("magick", [file, "-alpha", "off", "-define", "png:color-type=2", file]);
      output(`[${GLOBAL}] Captured ${name}.png (${width}x${height})`);
    }
    return version;
  });
  await installSection(dir, join(paths.bundle, GLOBAL, "promo"));
  await stampGenerated({
    bundle: paths.bundle,
    version,
    sections: [sectionId(GLOBAL, "promo")],
    env,
  });
  output(`Stamped global/promo for ${version}.`);
}
