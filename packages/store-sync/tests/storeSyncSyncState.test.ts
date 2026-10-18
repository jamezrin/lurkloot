import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBundle,
  stampBundle,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/bundle.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../src/cli.mjs";
import {
  syncStoreListing as sync,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/sync.mjs";
import {
  hashFiles,
  isUnchanged,
  readSyncState,
  recordSync,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/syncState.mjs";
import { makeBundle, png, useTemporaryDirectories } from "./helpers/bundle";

useTemporaryDirectories();

const everything = { descriptions: false, screenshots: true, global: true };

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
  async openAndWaitForAuthentication() {}
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
  async reload() {}
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

const spec = {
  locales: { ja: { screenshots: 5 }, id: { screenshots: 5 } },
  global: { screenshots: 5 },
};

async function recordState(dir: string, dashboard: Dashboard) {
  const bundle = await readBundle(dir);
  const entries: [string, unknown][] = [];
  for (const locale of bundle.locales) {
    await dashboard.selectLocale(locale);
    entries.push([
      locale,
      {
        files: await hashFiles(bundle.scope(locale).screenshots),
        thumbnails: await dashboard.thumbnailIds("localized"),
      },
    ]);
  }
  entries.push([
    "global",
    {
      files: await hashFiles(bundle.global.screenshots),
      thumbnails: await dashboard.thumbnailIds("global"),
    },
  ]);
  await recordSync({ dir, entries });
  return readSyncState(dir);
}

async function run(dir: string, dashboard: Dashboard, options: Record<string, unknown> = {}) {
  const bundle = await readBundle(dir);
  const progress: string[] = [];
  await sync({
    bundle,
    locales: bundle.locales,
    parts: everything,
    dashboard,
    onProgress: ({ locale, phase }: { locale: string; phase: string }) =>
      progress.push(`${locale}:${phase}`),
    ...options,
  });
  return progress;
}

async function syncedOnce() {
  const dir = await makeBundle(spec);
  const dashboard = new Dashboard();
  await run(dir, dashboard);
  const previousState = await recordState(dir, dashboard);
  dashboard.uploads = 0;
  dashboard.removals = 0;
  return { dir, dashboard, previousState };
}

describe("skipping screenshots the last verified sync already left in place", () => {
  it("uploads nothing when the files and the dashboard are both as recorded", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();

    const progress = await run(dir, dashboard, { previousState });

    expect(dashboard.uploads).toBe(0);
    expect(dashboard.removals).toBe(0);
    expect(progress).toEqual(
      expect.arrayContaining([
        "ja:screenshots-unchanged",
        "id:screenshots-unchanged",
        "global:screenshots-unchanged",
      ]),
    );
  });

  it("uploads again when a local image changed", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();
    // A producer regenerated this section, so it is stamped again.
    writeFileSync(
      join(dir, "ja", "screenshots", "01-drops.png"),
      png(1280, 800, "a different capture"),
    );
    await stampBundle({
      dir,
      name: "acme",
      source: { version: "1.18.0", commit: "x", dirty: false },
      sections: ["ja/screenshots"],
    });

    await run(dir, dashboard, { previousState });

    expect(dashboard.uploads).toBe(5);
    expect(dashboard.localized.get("id")).toHaveLength(5);
  });

  it("uploads again when someone changed the dashboard by hand", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();
    (dashboard.localized.get("ja") as string[])[2] = "uploaded-by-hand";

    await run(dir, dashboard, { previousState });

    expect(dashboard.uploads).toBe(5);
    expect(dashboard.localized.get("ja")).not.toContain("uploaded-by-hand");
  });

  it("uploads again when forced", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();

    await run(dir, dashboard, { previousState, force: true });

    expect(dashboard.uploads).toBe(15);
  });

  it("treats a group with no record as changed", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();
    delete previousState.scopes.id;

    await run(dir, dashboard, { previousState });

    expect(dashboard.uploads).toBe(5);
  });

  it("skips the shared group on its own record", async () => {
    const { dir, dashboard, previousState } = await syncedOnce();
    dashboard.global[0] = "changed-by-hand";

    await run(dir, dashboard, { previousState });

    expect(dashboard.uploads).toBe(5);
    expect(dashboard.global).not.toContain("changed-by-hand");
  });
});

describe("sync state", () => {
  it("keeps other groups when it records some", async () => {
    const dir = await makeBundle({});
    await recordSync({ dir, entries: [["ja", { files: { a: "1" }, thumbnails: ["x"] }]] });
    await recordSync({ dir, entries: [["id", { files: { a: "2" }, thumbnails: ["y"] }]] });

    const state = await readSyncState(dir);

    expect(Object.keys(state.scopes).sort()).toEqual(["id", "ja"]);
  });

  it("starts empty when nothing was recorded", async () => {
    expect((await readSyncState(await makeBundle({}))).scopes).toEqual({});
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

  function cli(dir: string, dashboard: Dashboard) {
    return main(["sync", "--bundle", dir, "--only", "screenshots", "--locales", "ja"], env, {
      output: () => {},
      expectedVersion: "1.18.0",
      openBrowser: async () => ({
        ownsBrowser: false,
        browser: { close: async () => {} },
        context: { newPage: async () => ({ close: async () => {} }) },
      }),
      createDashboard: () => dashboard,
      finishBrowser: async () => {},
      abandonBrowser: async () => {},
    });
  }

  it("records what a fresh load showed once the readback passes", async () => {
    const dir = await makeBundle(spec);
    const dashboard = new Dashboard();

    await cli(dir, dashboard);

    const state = await readSyncState(dir);
    expect(state.scopes.ja.thumbnails).toEqual(dashboard.localized.get("ja"));
    expect(Object.keys(state.scopes.ja.files)).toHaveLength(5);
    expect(state.scopes.id).toBeUndefined();
    expect(readFileSync(join(dir, "sync-state.json"), "utf8")).toContain('"ja"');
  });

  it("records nothing when the readback finds a difference", async () => {
    const dir = await makeBundle(spec);
    const dashboard = new Dashboard();
    dashboard.readLocaleState = async (locale: string) => ({
      locale,
      description: "",
      localized: ["only-one"],
      global: [],
    });

    await expect(cli(dir, dashboard)).rejects.toThrow(/Readback does not match/);

    expect((await readSyncState(dir)).scopes).toEqual({});
  });
});
