import { join } from "node:path";
import { GLOBAL, sectionId } from "@lurkloot/store-sync";
import { DEFAULT_LOCALE, PATHS, SCREENSHOT_SIZE, SCREENSHOTS } from "../lurkloot.mjs";
import { STORY_READINESS, withPopup } from "./popup.mjs";
import {
  installSection,
  removeSection,
  resetStaging,
  stagingPath,
  stampGenerated,
} from "./sections.mjs";

// The group a locale's screenshots are generated into. The default language
// has no group of its own on the dashboard; its artwork is the shared one.
export const screenshotScope = (locale) => (locale === DEFAULT_LOCALE ? GLOBAL : locale);

async function shoot({ page, origin, popupPath, locale, shot, file, output }) {
  const readiness = STORY_READINESS[shot.story];
  await page.goto(`${origin}${popupPath}?screenshot=store&story=${shot.story}&locale=${locale}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector(readiness.selector);
  if (readiness.open) {
    await page.locator(readiness.open).click();
    await page.waitForSelector(readiness.then);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  });
  await page.waitForSelector("[data-artwork-heading-ready]");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const heading = document.querySelector("[data-artwork-heading]");
    if (
      !heading
      || heading.offsetHeight > heading.parentElement.clientHeight
      || heading.scrollWidth > heading.clientWidth
    ) {
      throw new Error("Artwork headline does not fit its reading area.");
    }
    const stage = document.querySelector("[data-store-popup]").getBoundingClientRect();
    const story = document.querySelector("[data-store-artwork]").dataset.storeArtwork;
    const requireInside = (selector, cameraSelector) => {
      const element = document.querySelector(selector);
      const camera = document.querySelector(cameraSelector);
      if (!element || !camera) throw new Error(`Missing artwork subject: ${selector}`);
      const box = element.getBoundingClientRect();
      const frame = camera.getBoundingClientRect();
      if (
        box.width <= 0
        || box.height <= 0
        || box.left < frame.left
        || box.right > frame.right
        || box.top < frame.top
        || box.bottom > frame.bottom
      ) {
        throw new Error(`Clipped artwork subject: ${selector}`);
      }
    };
    if (story === "queue" || story === "kick") {
      requireInside(".store-reward-film", ".store-reward-camera");
    }
    if (story === "kick") {
      requireInside('[data-account-progress="kick"]', ".store-progress-focus");
    }
    // The zoomed tiles are copies; they must match the settled, translated source.
    for (const camera of document.querySelectorAll(".store-reward-camera")) {
      const source = [
        ...camera.querySelectorAll(".store-camera-source [data-campaign-id] [data-reward-row] > *"),
      ].map((tile) => tile.textContent);
      for (const copy of camera.querySelector(".store-reward-film").children) {
        if (!source.includes(copy.textContent)) {
          throw new Error(`Stale reward tile copy: ${copy.textContent}`);
        }
      }
    }
    for (const detail of document.querySelectorAll("[data-artwork-detail]")) {
      const box = detail.getBoundingClientRect();
      if (detail.scrollWidth > detail.clientWidth || box.bottom > stage.bottom) {
        throw new Error("Artwork detail does not fit its reading area.");
      }
    }
  });
  const bounds = await page.locator("[data-store-popup]").boundingBox();
  if (
    !bounds
    || bounds.width > 1152
    || bounds.width <= 0
    || bounds.height > 600
    || bounds.height <= 0
    || bounds.x < 0
    || bounds.y < 0
    || bounds.x + bounds.width > SCREENSHOT_SIZE.width
    || bounds.y + bounds.height > SCREENSHOT_SIZE.height
  ) {
    throw new Error(`Invalid artwork focus: ${JSON.stringify(bounds)}`);
  }
  await page.screenshot({ path: file, clip: { x: 0, y: 0, ...SCREENSHOT_SIZE } });
  const visibleText = (await page.locator("body").innerText()).replaceAll("Chrome Runner Skin", "");
  if (/NoPixel|Fortnite|Firefox|Chrome/i.test(visibleText)) {
    throw new Error(
      `Unexpected named provider or browser in ${shot.story}: ${visibleText.match(/.{0,60}(?:NoPixel|Fortnite|Firefox|Chrome).{0,60}/gi)}`,
    );
  }
  output(`[${locale}] Captured ${shot.file}.png: ${JSON.stringify(bounds)}`);
}

export async function generateScreenshots({ locales, paths = PATHS, output = console.log, env }) {
  await resetStaging(paths.bundle);
  const sections = [];
  const forget = [];
  const staged = new Map();
  const version = await withPopup(paths.build, async ({ page, origin, popupPath, version }) => {
    await page.setViewportSize({ ...SCREENSHOT_SIZE });
    for (const locale of locales) {
      const scope = screenshotScope(locale);
      const dir = stagingPath(paths.bundle, scope, "screenshots");
      for (const shot of SCREENSHOTS) {
        await shoot({
          page,
          origin,
          popupPath,
          locale,
          shot,
          file: join(dir, `${shot.file}.png`),
          output,
        });
      }
      staged.set(scope, dir);
    }
    return version;
  });
  for (const [scope, dir] of staged) {
    await installSection(dir, join(paths.bundle, scope, "screenshots"));
    sections.push(sectionId(scope, "screenshots"));
  }
  // The default language used to be given a group of its own too, which the
  // dashboard never shows; drop anything an older run left there.
  if (locales.includes(DEFAULT_LOCALE)) {
    await removeSection(join(paths.bundle, DEFAULT_LOCALE, "screenshots"));
    forget.push(sectionId(DEFAULT_LOCALE, "screenshots"));
  }
  await stampGenerated({ bundle: paths.bundle, version, sections, forget, env });
  output(`Stamped ${sections.join(", ")} for ${version}.`);
}
