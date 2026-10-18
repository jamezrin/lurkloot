import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCaptureProvenance,
  gitProvenance,
  readCaptureManifest,
  recordCapture,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing/core/provenance.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING } from "../scripts/store-listing/lurkloot.mjs";

const directories: string[] = [];
const git = { commit: "1ec05403dc4a391f45553c57981caa61f9dd36b4", dirty: false };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function captured(locales: string[], contents = "image") {
  const dir = mkdtempSync(join(tmpdir(), "lurkloot-provenance-"));
  directories.push(dir);
  for (const locale of locales) {
    mkdirSync(join(dir, locale), { recursive: true });
    for (const variant of LISTING.screenshots) {
      writeFileSync(
        join(dir, locale, LISTING.screenshotFilename(variant)),
        `${contents}-${locale}`,
      );
    }
  }
  return dir;
}

function filesFor(dir: string, locales: string[]) {
  return new Map(
    locales.map((locale) => [
      locale,
      LISTING.screenshots.map((variant: unknown) => ({
        variant,
        path: join(dir, locale, LISTING.screenshotFilename(variant)),
      })),
    ]),
  );
}

async function record(dir: string, locales: string[], version = "1.18.0", state = git) {
  return recordCapture({ dir, listing: LISTING, locales, version, git: state });
}

async function check(dir: string, locales: string[], options: Record<string, unknown> = {}) {
  return checkCaptureProvenance({
    manifest: await readCaptureManifest(dir),
    listing: LISTING,
    locales,
    filesByLocale: filesFor(dir, locales),
    expectedVersion: "1.18.0",
    ...options,
  });
}

describe("capture provenance", () => {
  it("accepts files captured from the version this checkout is at", async () => {
    const dir = captured(["ja", "id"]);
    await record(dir, ["ja", "id"]);

    expect((await check(dir, ["ja", "id"])).versions).toEqual(["1.18.0"]);
  });

  it("refuses screenshots when no manifest was written", async () => {
    const dir = captured(["ja"]);

    await expect(check(dir, ["ja"])).rejects.toThrow(/no capture-manifest\.json/i);
  });

  it("refuses screenshots captured from another version", async () => {
    const dir = captured(["ja"]);
    await record(dir, ["ja"], "1.17.2");

    await expect(check(dir, ["ja"])).rejects.toThrow(/ja: captured from 1\.17\.2.*is 1\.18\.0/s);
    expect((await check(dir, ["ja"], { allowVersionMismatch: true })).versions).toEqual(["1.17.2"]);
  });

  it("refuses locales captured from different versions", async () => {
    const dir = captured(["ja", "id"]);
    await record(dir, ["ja"], "1.18.0");
    await record(dir, ["id"], "1.17.2");

    await expect(check(dir, ["ja", "id"])).rejects.toThrow(
      /different versions \(ja 1\.18\.0, id 1\.17\.2\)/,
    );
  });

  it("keeps earlier locales when a later capture records others", async () => {
    const dir = captured(["ja", "id"]);
    await record(dir, ["ja"]);
    await record(dir, ["id"]);

    const manifest = await readCaptureManifest(dir);
    expect(Object.keys(manifest.locales).sort()).toEqual(["id", "ja"]);
  });

  it("refuses an image edited after it was captured", async () => {
    const dir = captured(["ja"]);
    await record(dir, ["ja"]);
    writeFileSync(join(dir, "ja", LISTING.screenshotFilename(LISTING.screenshots[0])), "edited");

    await expect(check(dir, ["ja"])).rejects.toThrow(/01-drops.*changed since it was captured/);
  });

  it("refuses a locale that was never captured", async () => {
    const dir = captured(["ja", "id"]);
    await record(dir, ["ja"]);

    await expect(check(dir, ["ja", "id"])).rejects.toThrow(/id: not captured/);
  });

  it("refuses a dirty working tree unless told otherwise", async () => {
    const dir = captured(["ja"]);
    await record(dir, ["ja"], "1.18.0", { ...git, dirty: true });

    await expect(check(dir, ["ja"])).rejects.toThrow(/uncommitted changes.*1ec05403/s);
    await expect(check(dir, ["ja"], { allowDirty: true })).resolves.toBeDefined();
  });

  it("reports every problem at once", async () => {
    const dir = captured(["ja", "id"]);
    await record(dir, ["ja"], "1.17.2");

    await expect(check(dir, ["ja", "id"])).rejects.toThrow(
      /ja: captured from.*\n.*id: not captured/s,
    );
  });

  it("reads the commit and dirtiness from git", async () => {
    const calls: string[][] = [];
    const exec = async (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === "rev-parse" ? `${git.commit}\n` : " M file.ts\n" };
    };

    expect(await gitProvenance({ cwd: "/repo", exec })).toEqual({
      commit: git.commit,
      dirty: true,
    });
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
    ]);
  });
});
