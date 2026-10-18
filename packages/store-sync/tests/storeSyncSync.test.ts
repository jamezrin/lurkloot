import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createContext,
  replaceScreenshots as replace,
  syncStoreListing as sync,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/sync.mjs";

const context = createContext({ command: "pnpm store:sync" });
const replaceLocaleScreenshots = (options: Record<string, unknown>) =>
  replace({ context, scope: options.locale, ...options });
const syncStoreListing = (options: Record<string, unknown>) => sync({ context, ...options });

type UploadFile = { name: string; path: string };

const files = (names: string[]): UploadFile[] =>
  names.map((number) => ({ name: `${number}-new.png`, path: `/bundle/${number}-new.png` }));
const desiredFiles = files(["01", "02", "03", "04", "05"]);

function imageId(path: string): string {
  return basename(path).match(/^(\d\d)-/)?.[1] ?? "unknown";
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
  descriptionsByLocale = new Map<string, string>();
  calls: string[] = [];

  get images(): string[] {
    if (!this.selectedLocale) return [];
    return this.imagesByLocale.get(this.selectedLocale) ?? [];
  }

  // The listing keeps a per-language set and a shared one; the language
  // selector moves only the former.
  imagesFor(section = "localized"): string[] {
    return section === "global" ? this.globalImages : this.images;
  }

  async preflight(_options?: unknown): Promise<void> {
    this.preflightCalls += 1;
  }

  async requireDistinctScreenshotSections(): Promise<void> {
    this.calls.push("section check");
  }

  async setDescription(text: string): Promise<boolean> {
    if (!this.selectedLocale) throw new Error("no locale selected");
    this.calls.push(`description ${this.selectedLocale}`);
    if (this.descriptionsByLocale.get(this.selectedLocale) === text) return false;
    this.descriptionsByLocale.set(this.selectedLocale, text);
    return true;
  }

  async selectLocale(locale: string): Promise<void> {
    this.selectedLocale = locale;
  }

  async screenshotCount(section?: string): Promise<number> {
    return this.imagesFor(section).length;
  }

  async removeFirstScreenshot(section?: string): Promise<void> {
    this.calls.push("remove");
    this.imagesFor(section).shift();
  }

  async waitForScreenshotCount(count: number, section?: string): Promise<void> {
    this.observedCounts.push(count);
    const images = this.imagesFor(section);
    if (images.length !== count) throw new Error(`expected ${count}, received ${images.length}`);
  }

  async uploadScreenshot(path: string, section?: string): Promise<void> {
    this.uploadCalls += 1;
    this.calls.push("upload");
    if (this.uploadCalls === this.failUploadAt) throw new Error("network upload failed");
    this.imagesFor(section).push(imageId(path));
  }

  async saveDraft(): Promise<void> {
    if (!this.selectedLocale) throw new Error("no locale selected");
    this.savedLocales.push(this.selectedLocale);
  }
}

const everything = { descriptions: true, screenshots: true, global: true };

type Scope = { description?: { text: string }; screenshots?: UploadFile[] };

// Just enough of a bundle for the sync to walk.
function bundleOf(locales: Record<string, Scope>, global?: UploadFile[]) {
  return {
    locales: Object.keys(locales),
    scope: (code: string) => locales[code],
    global: global ? { screenshots: global } : undefined,
  };
}

describe("store listing sync", () => {
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

    await expect(
      replaceLocaleScreenshots({ locale: "ar", files: desiredFiles, dashboard }),
    ).rejects.toThrow(
      /ar.*03-new.*upload.*network upload failed.*retry.*pnpm store:sync --locales ar/i,
    );
    expect(dashboard.savedLocales).toEqual([]);
    expect(dashboard.images).toHaveLength(4);
  });

  it("fills a language that has no screenshots yet in order without removing anything", async () => {
    const dashboard = new MemoryDashboard(new Map([["ja", []]]));

    await replaceLocaleScreenshots({ locale: "ja", files: desiredFiles, dashboard });

    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.calls).not.toContain("remove");
    expect(dashboard.observedCounts).toEqual([1, 2, 3, 4, 5]);
    expect(dashboard.globalImages).toEqual(["old-a", "old-b", "old-c", "old-d", "old-e"]);
  });

  it("tops up a partial set before rotating every image into place", async () => {
    const dashboard = new MemoryDashboard(new Map([["ja", ["old-a", "old-b"]]]));

    await replaceLocaleScreenshots({ locale: "ja", files: desiredFiles, dashboard });

    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.observedCounts.slice(0, 3)).toEqual([3, 4, 5]);
  });

  it("trims a set that is longer than the one wanted, then rotates the rest into place", async () => {
    const dashboard = new MemoryDashboard(
      new Map([["ja", ["old-a", "old-b", "old-c", "old-d", "old-e"]]]),
    );

    await replaceLocaleScreenshots({ locale: "ja", files: files(["01", "02", "03"]), dashboard });

    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01", "02", "03"]);
    expect(dashboard.observedCounts).toEqual([4, 3, 2, 3, 2, 3, 2, 3]);
    expect(dashboard.savedLocales).toEqual(["ja"]);
  });

  it("can reduce a full set to a single screenshot", async () => {
    const dashboard = new MemoryDashboard(
      new Map([["ja", ["old-a", "old-b", "old-c", "old-d", "old-e"]]]),
    );

    await replaceLocaleScreenshots({ locale: "ja", files: files(["01"]), dashboard });

    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01"]);
  });

  it("grows a short set to the number wanted", async () => {
    const dashboard = new MemoryDashboard(new Map([["ja", ["old-a", "old-b"]]]));

    await replaceLocaleScreenshots({
      locale: "ja",
      files: files(["01", "02", "03", "04"]),
      dashboard,
    });

    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01", "02", "03", "04"]);
  });

  it("checks the sections are distinct before changing any screenshot", async () => {
    const dashboard = new MemoryDashboard(new Map([["ja", []]]));
    dashboard.requireDistinctScreenshotSections = async () => {
      throw new Error("same panel");
    };

    await expect(
      replaceLocaleScreenshots({ locale: "ja", files: desiredFiles, dashboard }),
    ).rejects.toThrow(/ja.*section check.*same panel/);
    expect(dashboard.uploadCalls).toBe(0);
  });

  it("names the shared group's own retry command when it fails", async () => {
    const dashboard = new MemoryDashboard();
    dashboard.failUploadAt = 2;

    await expect(
      replaceLocaleScreenshots({
        locale: "global",
        files: desiredFiles,
        dashboard,
        section: "global",
      }),
    ).rejects.toThrow(/global.*retry with: pnpm store:sync --only global/i);
  });
});

describe("syncing a bundle", () => {
  it("preflights once and saves each group only after its complete replacement", async () => {
    const dashboard = new MemoryDashboard(
      new Map([
        ["ja", ["old-a", "old-b", "old-c", "old-d", "old-e"]],
        ["ar", ["old-a", "old-b", "old-c", "old-d", "old-e"]],
      ]),
    );
    const bundle = bundleOf(
      { ja: { screenshots: desiredFiles }, ar: { screenshots: desiredFiles } },
      desiredFiles,
    );

    await syncStoreListing({ bundle, locales: ["ja", "ar"], parts: everything, dashboard });

    expect(dashboard.preflightCalls).toBe(1);
    expect(dashboard.imagesByLocale.get("ja")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.imagesByLocale.get("ar")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.globalImages).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.savedLocales).toHaveLength(3);
  });

  it("leaves the shared group alone when the run did not ask for it", async () => {
    const dashboard = new MemoryDashboard(
      new Map([["ar", ["old-a", "old-b", "old-c", "old-d", "old-e"]]]),
    );
    const bundle = bundleOf({ ar: { screenshots: desiredFiles } }, desiredFiles);

    await syncStoreListing({
      bundle,
      locales: ["ar"],
      parts: { ...everything, global: false },
      dashboard,
    });

    expect(dashboard.imagesByLocale.get("ar")).toEqual(["01", "02", "03", "04", "05"]);
    expect(dashboard.globalImages).toEqual(["old-a", "old-b", "old-c", "old-d", "old-e"]);
  });

  it("syncs only the shared group, preflighting through the first language", async () => {
    const dashboard = new MemoryDashboard();
    const preflights: unknown[] = [];
    dashboard.preflight = async (options: { locales: string[] }) => {
      preflights.push(options);
      // The real preflight leaves the first language selected.
      dashboard.selectedLocale = options.locales[0];
    };
    const bundle = bundleOf({ ja: { screenshots: desiredFiles } }, desiredFiles);

    await syncStoreListing({
      bundle,
      locales: [],
      parts: { descriptions: false, screenshots: false, global: true },
      dashboard,
    });

    expect(dashboard.globalImages).toEqual(["01", "02", "03", "04", "05"]);
    expect(preflights).toEqual([{ locales: ["ja"], screenshots: true, descriptions: false }]);
  });

  it("gives a language with no screenshots of its own none, and does not touch its group", async () => {
    const dashboard = new MemoryDashboard(new Map([["en", ["keep"]]]));
    const bundle = bundleOf({ en: { description: { text: "English body" } } }, desiredFiles);

    await syncStoreListing({ bundle, locales: ["en"], parts: everything, dashboard });

    expect(dashboard.imagesByLocale.get("en")).toEqual(["keep"]);
    expect(dashboard.globalImages).toEqual(["01", "02", "03", "04", "05"]);
  });

  it("sets each description and saves only the languages that changed", async () => {
    const dashboard = new MemoryDashboard(
      new Map([
        ["en", []],
        ["ja", []],
      ]),
    );
    dashboard.descriptionsByLocale.set("en", "English body");
    const progress: string[] = [];
    const bundle = bundleOf({
      en: { description: { text: "English body" } },
      ja: { description: { text: "Japanese body" } },
    });

    await syncStoreListing({
      bundle,
      locales: ["en", "ja"],
      parts: { descriptions: true, screenshots: false, global: false },
      dashboard,
      onProgress: ({ locale, phase }: { locale: string; phase: string }) =>
        progress.push(`${locale} ${phase}`),
    });

    expect(dashboard.descriptionsByLocale.get("ja")).toBe("Japanese body");
    expect(dashboard.savedLocales).toEqual(["ja"]);
    expect(progress).toEqual(["en description-unchanged", "ja description-saved"]);
  });

  it("leaves screenshots alone in a descriptions-only run", async () => {
    const dashboard = new MemoryDashboard(new Map([["en", ["old-a"]]]));
    const bundle = bundleOf(
      { en: { description: { text: "English body" }, screenshots: desiredFiles } },
      desiredFiles,
    );

    await syncStoreListing({
      bundle,
      locales: ["en"],
      parts: { descriptions: true, screenshots: false, global: false },
      dashboard,
    });

    expect(dashboard.calls).toEqual(["description en"]);
    expect(dashboard.globalImages).toEqual(["old-a", "old-b", "old-c", "old-d", "old-e"]);
  });
});
