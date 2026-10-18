import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../scripts/store-listing/cli.mjs";
import {
  syncStoreListing as sync,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing/core/sync.mjs";
import {
  hashFiles,
  isUnchanged,
  readSyncState,
  recordSync,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing/core/syncState.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING } from "../scripts/store-listing/lurkloot.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type File = { variant: { file: string }; path: string };

function filesFor(locales: string[], contents = "v1") {
  const dir = mkdtempSync(join(tmpdir(), "lurkloot-sync-state-"));
  directories.push(dir);
  const byLocale = new Map<string, File[]>();
  for (const locale of locales) {
    mkdirSync(join(dir, locale), { recursive: true });
    byLocale.set(
      locale,
      LISTING.screenshots.map((variant: { file: string }) => {
        const path = join(dir, locale, LISTING.screenshotFilename(variant));
        writeFileSync(path, `${contents}-${locale}-${variant.file}`);
        return { variant, path };
      }),
    );
  }
  return { dir, byLocale };
}

// Models the dashboard closely enough for the replace loop: each upload becomes
// a new hosted image with an id of its own.
class Dashboard {
  hasMutated = false;
  selected = "";
  uploads = 0;
  removals = 0;
  localized = new Map<string, string[]>();
  global: string[] = [];
  next = 0;
  reloads = 0;
  async preflight() {}
  async selectLocale(locale: string) {
    this.selected = locale;
  }
  group(section = "localized") {
    if (section === "global") return this.global;
    if (!this.localized.has(this.selected)) this.localized.set(this.selected, []);
    return this.localized.get(this.selected) as string[];
  }
  async requireDistinctScreenshotSections() {}
  async thumbnailIds(section?: string) {
    return [...this.group(section)];
  }
  async screenshotCount(section?: string) {
    return this.group(section).length;
  }
  async removeFirstScreenshot(section?: string) {
    this.removals += 1;
    this.group(section).shift();
  }
  async uploadScreenshot(_path: string, section?: string) {
    this.uploads += 1;
    this.group(section).push(`id-${this.next++}`);
  }
  async waitForScreenshotCount() {}
  async saveDraft() {}
  async reload() {
    this.reloads += 1;
  }
  async readLocaleState(locale: string) {
    await this.selectLocale(locale);
    return {
      locale,
      description: "",
      localized: [...this.group("localized")],
      global: [...this.global],
    };
  }
}

async function stateFor(dir: string, dashboard: Dashboard, files: Map<string, File[]>) {
  const entries: [string, unknown][] = [];
  for (const [locale, list] of files) {
    await dashboard.selectLocale(locale);
    entries.push([
      locale,
      {
        files: await hashFiles(list),
        thumbnails: await dashboard.thumbnailIds(
          locale === LISTING.globalScreenshotsFrom ? "global" : "localized",
        ),
      },
    ]);
  }
  await recordSync({ dir, listing: LISTING, entries });
  return readSyncState(dir, LISTING);
}

function run(dashboard: Dashboard, files: Map<string, File[]>, options: Record<string, unknown>) {
  const progress: string[] = [];
  const done = sync({
    listing: LISTING,
    locales: [...files.keys()],
    filesByLocale: files,
    dashboard,
    onProgress: ({ locale, phase }: { locale: string; phase: string }) =>
      progress.push(`${locale}:${phase}`),
    ...options,
  });
  return { done, progress };
}

describe("skipping screenshots the last verified sync already left in place", () => {
  it("uploads nothing when the files and the dashboard are both as recorded", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();
    await run(dashboard, byLocale, {}).done;
    const previousState = await stateFor(dir, dashboard, byLocale);
    dashboard.uploads = 0;

    const { done, progress } = run(dashboard, byLocale, { previousState });
    await done;

    expect(dashboard.uploads).toBe(0);
    expect(dashboard.removals).toBe(0);
    expect(progress).toContain("ja:screenshots-unchanged");
  });

  it("uploads again when a local image changed", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();
    await run(dashboard, byLocale, {}).done;
    const previousState = await stateFor(dir, dashboard, byLocale);
    const [first] = byLocale.get("ja") as File[];
    writeFileSync(first.path, "a different capture");
    dashboard.uploads = 0;

    await run(dashboard, byLocale, { previousState }).done;

    expect(dashboard.uploads).toBe(5);
  });

  it("uploads again when someone changed the dashboard by hand", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();
    await run(dashboard, byLocale, {}).done;
    const previousState = await stateFor(dir, dashboard, byLocale);
    (dashboard.localized.get("ja") as string[])[2] = "uploaded-by-hand";
    dashboard.uploads = 0;

    await run(dashboard, byLocale, { previousState }).done;

    expect(dashboard.uploads).toBe(5);
    expect(dashboard.localized.get("ja")).not.toContain("uploaded-by-hand");
  });

  it("uploads again when forced", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();
    await run(dashboard, byLocale, {}).done;
    const previousState = await stateFor(dir, dashboard, byLocale);
    dashboard.uploads = 0;

    await run(dashboard, byLocale, { previousState, force: true }).done;

    expect(dashboard.uploads).toBe(5);
  });

  it("treats a language with no record as changed", async () => {
    const { dir, byLocale } = filesFor(["ja", "id"]);
    const dashboard = new Dashboard();
    await run(dashboard, new Map([["ja", byLocale.get("ja") as File[]]]), {}).done;
    const previousState = await stateFor(
      dir,
      dashboard,
      new Map([["ja", byLocale.get("ja") as File[]]]),
    );
    dashboard.uploads = 0;

    await run(dashboard, byLocale, { previousState }).done;

    expect(dashboard.uploads).toBe(5);
    expect(dashboard.localized.get("id")).toHaveLength(5);
  });

  it("leaves the shared group alone when the source language is unchanged", async () => {
    const { dir, byLocale } = filesFor(["en"]);
    const dashboard = new Dashboard();
    await run(dashboard, byLocale, {}).done;
    const previousState = await stateFor(dir, dashboard, byLocale);
    dashboard.uploads = 0;

    await run(dashboard, byLocale, { previousState }).done;

    expect(dashboard.uploads).toBe(0);
  });
});

describe("sync state", () => {
  it("keeps other languages when it records some", async () => {
    const { dir } = filesFor([]);
    await recordSync({
      dir,
      listing: LISTING,
      entries: [["ja", { files: { a: "1" }, thumbnails: ["x"] }]],
    });
    await recordSync({
      dir,
      listing: LISTING,
      entries: [["id", { files: { a: "2" }, thumbnails: ["y"] }]],
    });

    const state = await readSyncState(dir, LISTING);

    expect(Object.keys(state.locales).sort()).toEqual(["id", "ja"]);
  });

  it("starts empty when nothing was recorded or another listing wrote it", async () => {
    const { dir } = filesFor([]);
    expect((await readSyncState(dir, LISTING)).locales).toEqual({});
    await recordSync({
      dir,
      listing: { name: "other" },
      entries: [["ja", { files: {}, thumbnails: [] }]],
    });
    expect((await readSyncState(dir, LISTING)).locales).toEqual({});
  });

  it("is unchanged only when count, hashes and thumbnails all agree", () => {
    const entry = { files: { a: "1", b: "2" }, thumbnails: ["x", "y"] };
    const same = { entry, hashes: { a: "1", b: "2" }, liveIds: ["x", "y"], expectedCount: 2 };

    expect(isUnchanged(same)).toBe(true);
    expect(isUnchanged({ ...same, entry: undefined })).toBe(false);
    expect(isUnchanged({ ...same, hashes: { a: "1", b: "3" } })).toBe(false);
    expect(isUnchanged({ ...same, liveIds: ["y", "x"] })).toBe(false);
    expect(isUnchanged({ ...same, liveIds: ["x"] })).toBe(false);
    expect(isUnchanged({ ...same, expectedCount: 3 })).toBe(false);
  });
});

describe("recording after a sync", () => {
  const env = {
    CWS_EXTENSION_ID: "aobaackpofkghaejdnnmpmeaiaoibhdn",
    CWS_PUBLISHER_ID: "12345678-1234-1234-1234-123456789abc",
  };

  function cli(dir: string, files: Map<string, File[]>, dashboard: Dashboard) {
    return main(["sync", "--only", "screenshots", "--locales", "ja"], env, {
      output: () => {},
      stateDir: dir,
      checkProvenance: async () => {},
      validateFiles: async () => files,
      openBrowser: async () => ({
        ownsBrowser: false,
        browser: { close: async () => {} },
        context: { newPage: async () => ({ close: async () => {} }) },
      }),
      createDashboard: () =>
        Object.assign(dashboard, { openAndWaitForAuthentication: async () => {} }),
      finishBrowser: async () => {},
      abandonBrowser: async () => {},
    });
  }

  it("records what a fresh load showed once the readback passes", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();

    await cli(dir, byLocale, dashboard);

    const state = await readSyncState(dir, LISTING);
    expect(state.locales.ja.thumbnails).toEqual(dashboard.localized.get("ja"));
    expect(Object.keys(state.locales.ja.files)).toHaveLength(5);
    expect(Object.keys(state.locales.ja.files).map((name) => basename(name))).toEqual(
      LISTING.screenshots.map(LISTING.screenshotFilename),
    );
  });

  it("records nothing when the readback finds a difference", async () => {
    const { dir, byLocale } = filesFor(["ja"]);
    const dashboard = new Dashboard();
    dashboard.readLocaleState = async (locale: string) => ({
      locale,
      description: "",
      localized: ["only-one"],
      global: [],
    });

    await expect(cli(dir, byLocale, dashboard)).rejects.toThrow(/Readback does not match/);

    expect((await readSyncState(dir, LISTING)).locales).toEqual({});
  });
});
