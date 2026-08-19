import { describe, expect, it } from "vitest";
import { basename } from "node:path";
// @ts-expect-error The production utility is an executable JavaScript module.
import { replaceLocaleScreenshots, uploadStoreScreenshots } from "../scripts/store-screenshot-upload.mjs";

type UploadFile = { variant: { file: string }; path: string };

const desiredFiles: UploadFile[] = ["01", "02", "03", "04", "05"].map((number) => ({
  variant: { file: `${number}-new` },
  path: `/screenshots/lurkloot-${number}-new-1280x800.png`,
}));

function imageId(path: string): string {
  return basename(path).match(/lurkloot-(\d\d)-/)?.[1] ?? "unknown";
}

class MemoryDashboard {
  imagesByLocale: Map<string, string[]>;
  selectedLocale?: string;
  observedCounts: number[] = [];
  savedLocales: string[] = [];
  preflightCalls = 0;
  uploadCalls = 0;
  failUploadAt?: number;

  constructor(imagesByLocale = new Map([["ar", ["old-a", "old-b", "old-c", "old-d", "old-e"]]])) {
    this.imagesByLocale = imagesByLocale;
  }

  globalImages: string[] = ["old-a", "old-b", "old-c", "old-d", "old-e"];
  savedSections: string[] = [];

  get images(): string[] {
    if (!this.selectedLocale) return [];
    return this.imagesByLocale.get(this.selectedLocale) ?? [];
  }

  // The listing keeps a per-language set and a shared one; the language
  // selector moves only the former.
  imagesFor(section = "localized"): string[] {
    return section === "global" ? this.globalImages : this.images;
  }

  async preflight(): Promise<void> {
    this.preflightCalls += 1;
  }

  async selectLocale(locale: string): Promise<void> {
    this.selectedLocale = locale;
  }

  async screenshotCount(section?: string): Promise<number> {
    return this.imagesFor(section).length;
  }

  async removeFirstScreenshot(section?: string): Promise<void> {
    this.imagesFor(section).shift();
  }

  async waitForScreenshotCount(count: number, section?: string): Promise<void> {
    this.observedCounts.push(count);
    const images = this.imagesFor(section);
    if (images.length !== count) throw new Error(`expected ${count}, received ${images.length}`);
  }

  async uploadScreenshot(path: string, section?: string): Promise<void> {
    this.uploadCalls += 1;
    if (this.uploadCalls === this.failUploadAt) throw new Error("network upload failed");
    this.imagesFor(section).push(imageId(path));
  }

  async saveDraft(): Promise<void> {
    if (!this.selectedLocale) throw new Error("no locale selected");
    this.savedLocales.push(this.selectedLocale);
  }
}

describe("store screenshot replacement", () => {
  it("rotates arbitrary screenshots into the exact desired order", async () => {
    const dashboard = new MemoryDashboard();

    await replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard });

    expect(dashboard.images).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.observedCounts).toEqual([4, 5, 4, 5, 4, 5, 4, 5, 4, 5]);
    expect(dashboard.savedLocales).toEqual(["ar"]);
  });

  it("is idempotent when every desired screenshot is already present", async () => {
    const dashboard = new MemoryDashboard(new Map([["ar", ["01", "02", "03", "04", "05"]]]));

    await replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard });

    expect(dashboard.images).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.savedLocales).toEqual(["ar"]);
  });

  it.each([
    ["before any replacement", ["old-a", "old-b", "old-c", "old-d", "old-e"]],
    ["after one replacement", ["old-b", "old-c", "old-d", "old-e", "01"]],
    ["after two replacements", ["old-c", "old-d", "old-e", "01", "02"]],
    ["after three replacements", ["old-d", "old-e", "01", "02", "03"]],
    ["after four replacements", ["old-e", "01", "02", "03", "04"]],
  ])("recovers %s by replacing the whole current set", async (_label, startingImages) => {
    const dashboard = new MemoryDashboard(new Map([["ar", startingImages]]));

    await replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard });

    expect(dashboard.images).toEqual(["01", "02", "03", "04", "05"]);
  });

  it("repairs a four-image state left by interruption before restarting the rotation", async () => {
    const dashboard = new MemoryDashboard(new Map([["ar", ["old-b", "old-c", "old-d", "old-e"]]]));

    await replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard });

    expect(dashboard.images).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.observedCounts).toEqual([5, 4, 5, 4, 5, 4, 5, 4, 5, 4, 5]);
  });

  it("does not save an incomplete locale and reports its exact failed phase", async () => {
    const dashboard = new MemoryDashboard();
    dashboard.failUploadAt = 3;

    await expect(replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard }))
      .rejects.toThrow(/ar.*03-new.*upload.*network upload failed.*retry.*--locales ar/i);
    expect(dashboard.savedLocales).toEqual([]);
    expect(dashboard.images).toHaveLength(4);
  });

  it("preflights once and saves each locale only after its complete replacement", async () => {
    const dashboard = new MemoryDashboard(new Map([
      ["en", ["old-a", "old-b", "old-c", "old-d", "old-e"]],
      ["ar", ["old-a", "old-b", "old-c", "old-d", "old-e"]],
    ]));
    const filesByLocale = new Map([["en", desiredFiles], ["ar", desiredFiles]]);

    await uploadStoreScreenshots({ locales: ["en", "ar"], filesByLocale, dashboard });

    expect(dashboard.preflightCalls).toBe(1);
    expect(dashboard.imagesByLocale.get("en")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.imagesByLocale.get("ar")).toEqual(["01", "02", "03", "04", "05"]);
    // The shared set is rewritten once, from the English artwork.
    expect(dashboard.globalImages).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.savedLocales).toHaveLength(3);
  });

  it("leaves the shared set alone when English is not part of the run", async () => {
    const dashboard = new MemoryDashboard(new Map([["ar", ["old-a", "old-b", "old-c", "old-d", "old-e"]]]));
    const filesByLocale = new Map([["ar", desiredFiles]]);

    await uploadStoreScreenshots({ locales: ["ar"], filesByLocale, dashboard });

    expect(dashboard.imagesByLocale.get("ar")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.globalImages).toEqual(["old-a", "old-b", "old-c", "old-d", "old-e"]);
  });
});
