import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { Toggle } from "../../popup-ui/src/primitives";

const stylesPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../popup-ui/src/styles.css",
);

// Compiles the popup's stylesheet exactly as the build does: Tailwind scans the
// popup's sources for candidate classes and emits the utilities they name.
async function buildPopupCss(): Promise<string> {
  const base = dirname(stylesPath);
  const compiler = await compile(await readFile(stylesPath, "utf8"), {
    base,
    onDependency: () => undefined,
  });
  const scanner = new Scanner({ sources: compiler.sources });
  return compiler.build(scanner.scan());
}

// Then lowers it the way the extension build does. Vite minifies CSS with
// Lightning CSS for its default browser targets, which rewrites some selectors:
// :dir(rtl) becomes a :lang() list, which never matches a popup that sets only
// `dir`. Raw Tailwind output would hide that.
async function lowerAsBuilt(css: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lurkloot-popup-css-"));
  try {
    const entry = join(root, "popup.css");
    await writeFile(entry, css);
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: { write: false, rollupOptions: { input: entry } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) =>
      "output" in bundle ? bundle.output : [],
    );
    const sheet = outputs.find((output) => output.fileName.endsWith(".css"));
    if (!sheet || sheet.type !== "asset") throw new Error("Vite must emit the stylesheet");
    return String(sheet.source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("popup stylesheet", () => {
  // An extension popup is re-measured after every layout by laying the
  // document out at a tiny width and back. A width media query flips on each of
  // those passes and forces a full style recalculation and relayout of the
  // popup — the regression behind a sluggish popup, brought in by Tailwind's
  // .container utility after a comment mentioned a "container query".
  it("has no viewport-width media queries", async () => {
    const css = await buildPopupCss();

    expect(css).toContain(".\\@container");
    expect(css.match(/@media[^{]*(width|height)[^{]*\{/g) ?? []).toEqual([]);
  });
});

describe("toggle layout", () => {
  let browser: Browser | undefined;
  let page: Page;
  let css: string;

  beforeAll(async () => {
    css = await lowerAsBuilt(await buildPopupCss());
    browser = await chromium.launch({ executablePath: process.env.CWS_CHROME_BINARY });
    page = await browser.newPage({ viewport: { width: 320, height: 160 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  afterAll(async () => browser?.close());

  it.each([
    { direction: "ltr", parentDirection: "ltr", size: "sm", distance: 13 },
    { direction: "ltr", parentDirection: "ltr", size: "md", distance: 16 },
    { direction: "rtl", parentDirection: "rtl", size: "sm", distance: -13 },
    { direction: "rtl", parentDirection: "rtl", size: "md", distance: -16 },
    { direction: "ltr", parentDirection: "rtl", size: "sm", distance: 13 },
    { direction: "ltr", parentDirection: "rtl", size: "md", distance: 16 },
    { direction: "rtl", parentDirection: "ltr", size: "sm", distance: -13 },
    { direction: "rtl", parentDirection: "ltr", size: "md", distance: -16 },
  ] as const)(
    "keeps the $size thumb inside its $direction track under $parentDirection",
    async ({ direction, parentDirection, size, distance }) => {
      // Exercise the real component and compiled utilities: a DOM emulator cannot
      // measure flex positioning or the resulting physical translation.
      await page.setContent(
        renderToStaticMarkup(
          createElement(
            "section",
            { dir: parentDirection },
            createElement(
              "div",
              { dir: direction },
              ...[false, true].map((checked) =>
                createElement(Toggle, {
                  key: String(checked),
                  checked,
                  onChange: () => undefined,
                  label: checked ? "On" : "Off",
                  size,
                }),
              ),
            ),
          ),
        ),
      );
      await page.addStyleTag({ content: css });

      const offsets: number[] = [];
      for (const checked of [false, true]) {
        const control = page.getByRole("switch", { name: checked ? "On" : "Off", exact: true });
        expect(await control.getAttribute("aria-checked")).toBe(String(checked));
        const track = await control.boundingBox();
        const thumb = await control.locator("span").first().boundingBox();
        if (!track || !thumb) throw new Error("Toggle must render a visible track and thumb");

        expect(thumb.x).toBeGreaterThanOrEqual(track.x + 1.5);
        expect(thumb.x + thumb.width).toBeLessThanOrEqual(track.x + track.width - 1.5);
        expect(thumb.y).toBeGreaterThanOrEqual(track.y + 1.5);
        expect(thumb.y + thumb.height).toBeLessThanOrEqual(track.y + track.height - 1.5);
        offsets.push(thumb.x - track.x);
      }
      expect(offsets[1] - offsets[0]).toBeCloseTo(distance, 1);
    },
  );
});
