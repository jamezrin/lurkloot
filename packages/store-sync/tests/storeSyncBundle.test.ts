import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBundle,
  stampBundle,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/bundle.mjs";
import {
  checkArtworkSources,
  gitProvenance,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/provenance.mjs";
import {
  NAMES,
  SOURCE,
  makeBundle,
  png,
  temporaryDirectory,
  useTemporaryDirectories,
  writeSection,
} from "./helpers/bundle";

useTemporaryDirectories();

const full = {
  locales: {
    ja: { description: "日本語の説明\n", screenshots: 5 },
    id: { description: "Deskripsi", screenshots: 3 },
  },
  global: { screenshots: 5, promo: true },
};

describe("reading a stamped bundle", () => {
  it("reads descriptions, screenshots in filename order, and the global group", async () => {
    const bundle = await readBundle(await makeBundle(full));

    expect(bundle.name).toBe("acme");
    expect(bundle.locales).toEqual(["id", "ja"]);
    expect(bundle.scope("ja").description.text).toBe("日本語の説明");
    expect(bundle.scope("ja").screenshots.map((file: { name: string }) => file.name)).toEqual(
      NAMES.map((name) => `${name}.png`),
    );
    expect(bundle.scope("id").screenshots).toHaveLength(3);
    expect(bundle.global.screenshots).toHaveLength(5);
    expect(Object.keys(bundle.global.promo).sort()).toEqual(["marquee", "small"]);
    expect(bundle.scope("ja").sources.screenshots.version).toBe(SOURCE.version);
  });

  it("refuses a directory nobody stamped", async () => {
    const dir = temporaryDirectory();
    writeSection(dir, "ja", "screenshots");

    await expect(readBundle(dir)).rejects.toThrow(/No bundle\.json/);
  });

  it("refuses a file edited after it was stamped", async () => {
    const dir = await makeBundle(full);
    writeFileSync(join(dir, "ja", "screenshots", "01-drops.png"), png(1280, 800, "edited"));

    await expect(readBundle(dir)).rejects.toThrow(
      /ja\/screenshots\/01-drops\.png: changed since it was stamped/,
    );
  });

  it("refuses a file added to a stamped section, or removed from it", async () => {
    const dir = await makeBundle(full);
    writeFileSync(join(dir, "id", "screenshots", "04-extra.png"), png());
    rmSync(join(dir, "ja", "screenshots", "03-easy.png"));

    const failure = readBundle(dir);
    await expect(failure).rejects.toThrow(/id\/screenshots\/04-extra\.png: not in the stamp/);
    await expect(failure).rejects.toThrow(/ja\/screenshots\/03-easy\.png: stamped but missing/);
  });

  it("refuses a section that was written but never stamped", async () => {
    const dir = await makeBundle(full);
    writeSection(dir, "fr", "screenshots");

    await expect(readBundle(dir)).rejects.toThrow(/fr\/screenshots: present but never stamped/);
  });

  it("refuses stray files and directories outside the layout", async () => {
    const dir = await makeBundle(full);
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "Not A Locale"));
    mkdirSync(join(dir, "ja", "promo"), { recursive: true });
    writeFileSync(join(dir, "ja", "promo", "small.png"), png(440, 280));

    const failure = readBundle(dir);
    await expect(failure).rejects.toThrow(/notes\.txt: stray file/);
    await expect(failure).rejects.toThrow(/Not A Locale\/: not a locale code/);
    await expect(failure).rejects.toThrow(/ja\/promo: not part of the layout/);
  });

  it("ignores the sync's own state file and hidden staging directories", async () => {
    const dir = await makeBundle(full);
    writeFileSync(join(dir, "sync-state.json"), "{}");
    mkdirSync(join(dir, ".generating", "ja"), { recursive: true });

    await expect(readBundle(dir)).resolves.toBeDefined();
  });
});

describe("what a section may hold", () => {
  async function stampOne(prepare: (dir: string) => void, section: string) {
    const dir = temporaryDirectory();
    prepare(dir);
    return stampBundle({ dir, name: "acme", source: SOURCE, sections: [section] });
  }

  it("takes up to five screenshots at 1280x800 or 640x400", async () => {
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja", "screenshots"), { recursive: true });
        writeFileSync(join(dir, "ja", "screenshots", "a.png"), png(640, 400));
        writeFileSync(join(dir, "ja", "screenshots", "b.png"), png(1280, 800));
      }, "ja/screenshots"),
    ).resolves.toBeDefined();
  });

  it("refuses a wrong size, a non-png, no files and too many", async () => {
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja", "screenshots"), { recursive: true });
        writeFileSync(join(dir, "ja", "screenshots", "a.png"), png(1000, 800));
      }, "ja/screenshots"),
    ).rejects.toThrow(/1000x800; screenshots must be 1280x800 or 640x400/);
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja", "screenshots"), { recursive: true });
        writeFileSync(join(dir, "ja", "screenshots", "a.jpg"), "x");
      }, "ja/screenshots"),
    ).rejects.toThrow(/a\.jpg is not a \.png/);
    await expect(
      stampOne(
        (dir) => mkdirSync(join(dir, "ja", "screenshots"), { recursive: true }),
        "ja/screenshots",
      ),
    ).rejects.toThrow(/no files/);
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja", "screenshots"), { recursive: true });
        for (const name of ["a", "b", "c", "d", "e", "f"]) {
          writeFileSync(join(dir, "ja", "screenshots", `${name}.png`), png());
        }
      }, "ja/screenshots"),
    ).rejects.toThrow(/6 screenshots; the store takes at most 5/);
  });

  it("refuses something that is not a png at all", async () => {
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja", "screenshots"), { recursive: true });
        writeFileSync(
          join(dir, "ja", "screenshots", "a.png"),
          "plain text, long enough to read a header from",
        );
      }, "ja/screenshots"),
    ).rejects.toThrow(/not a PNG with an IHDR header/);
  });

  it("keeps promo tiles to the shared group, at their exact sizes", async () => {
    await expect(stampOne((dir) => writeSection(dir, "ja", "promo"), "ja/promo")).rejects.toThrow(
      /belong in global\/promo/,
    );
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "global", "promo"), { recursive: true });
        writeFileSync(join(dir, "global", "promo", "small.png"), png(440, 281));
      }, "global/promo"),
    ).rejects.toThrow(/440x281; expected 440x280/);
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "global", "promo"), { recursive: true });
        writeFileSync(join(dir, "global", "promo", "tiny.png"), png(1, 1));
      }, "global/promo"),
    ).rejects.toThrow(/tiny\.png is not one of small\.png, marquee\.png/);
  });

  it("refuses an empty or over-long description, and one for the global group", async () => {
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja"));
        writeFileSync(join(dir, "ja", "description.txt"), "  \n");
      }, "ja/description"),
    ).rejects.toThrow(/description is empty/);
    await expect(
      stampOne((dir) => {
        mkdirSync(join(dir, "ja"));
        writeFileSync(join(dir, "ja", "description.txt"), "あ".repeat(16_001));
      }, "ja/description"),
    ).rejects.toThrow(/16001 characters; the limit is 16000/);
    await expect(stampOne(() => {}, "global/description")).rejects.toThrow(/not a description/);
  });

  it("refuses a section name that is not a locale or global", async () => {
    await expect(stampOne(() => {}, "Not A Locale/screenshots")).rejects.toThrow(
      /not a locale code/,
    );
    await expect(stampOne(() => {}, "ja/trailer")).rejects.toThrow(/part must be one of/);
  });
});

describe("stamping", () => {
  it("keeps sections it was not asked about", async () => {
    const dir = await makeBundle(full);
    rmSync(join(dir, "ja", "screenshots"), { recursive: true });
    writeSection(dir, "ja", "screenshots", 4, "v2");

    const manifest = await stampBundle({
      dir,
      name: "acme",
      source: { ...SOURCE, version: "1.19.0" },
      sections: ["ja/screenshots"],
    });

    expect(Object.keys(manifest.sections)).toEqual(
      expect.arrayContaining([
        "id/description",
        "id/screenshots",
        "ja/description",
        "global/promo",
      ]),
    );
    expect(manifest.sections["ja/screenshots"].source.version).toBe("1.19.0");
    expect(manifest.sections["id/screenshots"].source.version).toBe(SOURCE.version);
    expect(Object.keys(manifest.sections["ja/screenshots"].files)).toHaveLength(4);
  });

  it("drops the record of a section a producer removed", async () => {
    const dir = await makeBundle(full);
    rmSync(join(dir, "id", "screenshots"), { recursive: true });

    await expect(readBundle(dir)).rejects.toThrow(/id\/screenshots: .*does not exist/);
    await stampBundle({ dir, name: "acme", source: SOURCE, forget: ["id/screenshots"] });

    expect((await readBundle(dir)).scope("id").screenshots).toBeUndefined();
  });

  it("leaves the sync state alone", async () => {
    const dir = await makeBundle(full);
    writeFileSync(join(dir, "sync-state.json"), '{"schema":1,"scopes":{}}');

    await stampBundle({ dir, name: "acme", source: SOURCE, sections: ["ja/screenshots"] });

    expect(readFileSync(join(dir, "sync-state.json"), "utf8")).toBe('{"schema":1,"scopes":{}}');
  });

  it("refuses a bundle that belongs to another name or extension", async () => {
    const dir = await makeBundle({ ...full, extensionId: "a".repeat(32) });

    await expect(stampBundle({ dir, name: "other", source: SOURCE })).rejects.toThrow(
      /holds the bundle for acme, not other/,
    );
    await expect(
      stampBundle({ dir, name: "acme", extensionId: "b".repeat(32), source: SOURCE }),
    ).rejects.toThrow(/stamped for extension a+, not b+/);
    expect((await readBundle(dir)).extensionId).toBe("a".repeat(32));
  });

  it("needs a version to say where the output came from", async () => {
    await expect(
      stampBundle({ dir: temporaryDirectory(), name: "acme", source: {} }),
    ).rejects.toThrow(/source\.version/);
  });
});

describe("artwork provenance", () => {
  async function bundleOf(spec: Parameters<typeof makeBundle>[0]) {
    return readBundle(await makeBundle(spec));
  }
  const check = (bundle: unknown, options: Record<string, unknown> = {}) =>
    checkArtworkSources({
      bundle,
      scopes: ["ja", "global"],
      expectedVersion: "1.18.0",
      ...options,
    });

  it("accepts artwork from the version this checkout is at", async () => {
    expect(check(await bundleOf(full)).versions).toEqual(["1.18.0"]);
  });

  it("refuses artwork from another version, unless told otherwise", async () => {
    const bundle = await bundleOf({ ...full, version: "1.17.2" });

    expect(() => check(bundle)).toThrow(
      /ja\/screenshots: generated from 1\.17\.2, but this checkout is 1\.18\.0/,
    );
    expect(check(bundle, { allowVersionMismatch: true }).versions).toEqual(["1.17.2"]);
  });

  it("refuses artwork from different versions", async () => {
    const dir = await makeBundle(full);
    writeSection(dir, "ja", "screenshots", 5, "v2");
    await stampBundle({
      dir,
      name: "acme",
      source: { ...SOURCE, version: "1.17.2" },
      sections: ["ja/screenshots"],
    });

    const bundle = await readBundle(dir);
    expect(() => check(bundle)).toThrow(/different versions \(.*ja\/screenshots 1\.17\.2.*\)/);
  });

  it("refuses artwork from a dirty tree, unless told otherwise", async () => {
    const bundle = await bundleOf({ ...full, dirty: true });

    expect(() => check(bundle)).toThrow(/uncommitted changes.*1ec05403/s);
    expect(check(bundle, { allowDirty: true })).toBeDefined();
  });

  it("checks nothing it was not asked to ship", async () => {
    const bundle = await bundleOf({ ...full, version: "1.17.2" });

    expect(check(bundle, { scopes: [] }).versions).toEqual([]);
  });

  it("reads the commit and tracked-file dirtiness from git, ignoring untracked files", async () => {
    const calls: string[][] = [];
    const exec = async (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: args[0] === "rev-parse" ? `${SOURCE.commit}\n` : "" };
    };

    expect(await gitProvenance({ cwd: "/repo", exec })).toEqual({
      commit: SOURCE.commit,
      dirty: false,
    });
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain", "--untracked-files=no"],
    ]);
  });

  it("reports a modified tracked file as dirty", async () => {
    const exec = async (_command: string, args: string[]) => ({
      stdout: args[0] === "rev-parse" ? "abc\n" : " M file.ts\n",
    });

    expect((await gitProvenance({ cwd: "/repo", exec })).dirty).toBe(true);
  });
});
