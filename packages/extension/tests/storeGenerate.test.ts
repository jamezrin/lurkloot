import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBundle, stampBundle } from "@lurkloot/store-sync";

// The generators drive a real browser against a real build. Everything around
// that is tested here with a page that only writes the file it was asked for.
vi.mock("../scripts/store/generate/popup.mjs", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const { writeFileSync: write, mkdirSync: mkdir } = await import("node:fs");
  const { dirname: parent } = await import("node:path");
  const header = (path: string) => {
    const bytes = Buffer.alloc(24 + path.length);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1280, 16);
    bytes.writeUInt32BE(800, 20);
    bytes.write(path, 24, "ascii");
    return bytes;
  };
  return {
    ...original,
    withPopup: async (
      _build: string,
      work: (context: Record<string, unknown>) => Promise<unknown>,
    ) =>
      work({
        origin: "http://popup.test",
        popupPath: "/popup.html",
        version: "7.7.7",
        page: {
          setViewportSize: async () => {},
          goto: async () => {},
          waitForSelector: async () => {},
          waitForTimeout: async () => {},
          evaluate: async () => {},
          locator: () => ({
            click: async () => {},
            boundingBox: async () => ({ x: 64, y: 390, width: 1152, height: 350 }),
            innerText: async () => "Queue",
          }),
          screenshot: async ({ path }: { path: string }) => {
            mkdir(parent(path), { recursive: true });
            write(path, header(path));
          },
        },
      }),
  };
});

// @ts-expect-error The generators are executable JavaScript modules.
import { descriptionsAreFresh, generate, main } from "../scripts/store/cli.mjs";
// @ts-expect-error The generators are executable JavaScript modules.
import { generateDescriptions } from "../scripts/store/generate/descriptions.mjs";
// @ts-expect-error The generators are executable JavaScript modules.
import { STORY_READINESS } from "../scripts/store/generate/popup.mjs";
// @ts-expect-error The generators are executable JavaScript modules.
import { generateScreenshots, screenshotScope } from "../scripts/store/generate/screenshots.mjs";
// @ts-expect-error The generators are executable JavaScript modules.
import { DEFAULT_LOCALE, LOCALES, PATHS, SCREENSHOTS } from "../scripts/store/lurkloot.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function bundleDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "lurkloot-store-"));
  directories.push(dir);
  return dir;
}

const quiet = () => {};
const pathsFor = (bundle: string) => ({ ...PATHS, bundle, build: "/not-built" });

describe("the Lurkloot listing profile", () => {
  it("has a readiness check for every story a screenshot renders", () => {
    for (const shot of SCREENSHOTS as { file: string; story: string }[]) {
      expect(STORY_READINESS[shot.story as keyof typeof STORY_READINESS], shot.file).toBeDefined();
    }
  });

  it("gives the default language's artwork to the shared group and every other its own", () => {
    expect(screenshotScope(DEFAULT_LOCALE)).toBe("global");
    expect(screenshotScope("ja")).toBe("ja");
  });
});

describe("generating descriptions", () => {
  it("copies and stamps a description for every listing language, within the limit", async () => {
    const bundle = bundleDirectory();

    await generateDescriptions({ locales: [...LOCALES], paths: pathsFor(bundle), output: quiet });

    const read = await readBundle(bundle);
    expect(read.locales).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      const source = readFileSync(join(PATHS.descriptions, `${locale}.txt`), "utf8").trim();
      expect(read.scope(locale)?.description?.text, locale).toBe(source);
    }
  });

  it("stamps the package's own version, since a description shows no build", async () => {
    const bundle = bundleDirectory();
    const { version } = JSON.parse(readFileSync(join(PATHS.packageRoot, "package.json"), "utf8"));

    await generateDescriptions({ locales: ["ja"], paths: pathsFor(bundle), output: quiet });

    expect((await readBundle(bundle)).scope("ja")?.sources.description?.version).toBe(version);
  });
});

describe("generating screenshots", () => {
  it("puts the default language in the shared group and the rest in their own, stamped for the built version", async () => {
    const bundle = bundleDirectory();

    await generateScreenshots({
      locales: ["en", "ja"],
      paths: pathsFor(bundle),
      output: quiet,
      env: { CWS_EXTENSION_ID: "aobaackpofkghaejdnnmpmeaiaoibhdn" },
    });

    const read = await readBundle(bundle);
    expect(read.locales).toEqual(["ja"]);
    expect(read.global?.screenshots?.map((file) => file.name)).toEqual(
      (SCREENSHOTS as { file: string }[]).map(({ file }) => `${file}.png`),
    );
    expect(read.scope("ja")?.screenshots).toHaveLength(SCREENSHOTS.length);
    expect(read.scope("ja")?.sources.screenshots?.version).toBe("7.7.7");
    expect(read.extensionId).toBe("aobaackpofkghaejdnnmpmeaiaoibhdn");
  });

  it("replaces only the languages it generated and leaves the rest and the sync state alone", async () => {
    const bundle = bundleDirectory();
    await generateScreenshots({
      locales: ["en", "ja", "id"],
      paths: pathsFor(bundle),
      output: quiet,
    });
    writeFileSync(join(bundle, "sync-state.json"), '{"schema":1,"scopes":{}}');
    const before = readFileSync(join(bundle, "id", "screenshots", "01-drops.png"));

    await generateScreenshots({ locales: ["ja"], paths: pathsFor(bundle), output: quiet });

    const read = await readBundle(bundle);
    expect(read.locales).toEqual(["id", "ja"]);
    expect(readFileSync(join(bundle, "id", "screenshots", "01-drops.png"))).toEqual(before);
    expect(readFileSync(join(bundle, "sync-state.json"), "utf8")).toBe('{"schema":1,"scopes":{}}');
    expect(read.global?.screenshots).toHaveLength(SCREENSHOTS.length);
  });

  it("drops a group an older run gave the default language", async () => {
    const bundle = bundleDirectory();
    await generateScreenshots({ locales: ["ja"], paths: pathsFor(bundle), output: quiet });
    mkdirSync(join(bundle, "en", "screenshots"), { recursive: true });
    cpSync(join(bundle, "ja", "screenshots"), join(bundle, "en", "screenshots"), {
      recursive: true,
    });
    await stampBundle({
      dir: bundle,
      name: "lurkloot",
      source: { version: "7.7.7" },
      sections: ["en/screenshots"],
    });

    await generateScreenshots({ locales: ["en"], paths: pathsFor(bundle), output: quiet });

    const read = await readBundle(bundle);
    expect(read.scope("en")?.screenshots).toBeUndefined();
    expect(read.global?.screenshots).toHaveLength(SCREENSHOTS.length);
  });

  it("leaves no staging directory behind", async () => {
    const bundle = bundleDirectory();

    await generateScreenshots({ locales: ["ja"], paths: pathsFor(bundle), output: quiet });

    expect(() => readFileSync(join(bundle, ".generating"))).toThrow();
    await expect(readBundle(bundle)).resolves.toBeDefined();
  });
});

describe("the generate command", () => {
  function recorder() {
    const calls: string[] = [];
    const make =
      (name: string) =>
      async ({ locales }: { locales: string[] }) => {
        calls.push(`${name}:${locales.join(",")}`);
      };
    return {
      calls,
      dependencies: {
        output: quiet,
        generateScreenshots: make("screenshots"),
        generatePromo: make("promo"),
        generateDescriptions: make("descriptions"),
      },
    };
  }

  it("runs every generator, once, over every language, when given nothing", async () => {
    const { calls, dependencies } = recorder();

    await generate([], {}, dependencies);

    expect(calls).toEqual([
      `screenshots:${LOCALES.join(",")}`,
      `promo:${LOCALES.join(",")}`,
      `descriptions:${LOCALES.join(",")}`,
    ]);
  });

  it("forwards --locales to every generator it runs", async () => {
    const { calls, dependencies } = recorder();

    await generate(["--locales", "en", "ja"], {}, dependencies);

    expect(calls).toEqual(["screenshots:en,ja", "promo:en,ja", "descriptions:en,ja"]);
  });

  it("makes the shared promo tiles only when the default language is part of the run", async () => {
    const { calls, dependencies } = recorder();

    await generate(["--locales", "ja"], {}, dependencies);

    expect(calls).toEqual(["screenshots:ja", "descriptions:ja"]);
    await expect(generate(["promo", "--locales", "ja"], {}, dependencies)).rejects.toThrow(
      /made from en; include it in --locales/,
    );
  });

  it("runs one generator when named", async () => {
    const { calls, dependencies } = recorder();

    await generate(["descriptions", "--locales", "ja"], {}, dependencies);

    expect(calls).toEqual(["descriptions:ja"]);
  });

  it("rejects an unknown locale, a repeated one and a missing value instead of skipping", async () => {
    const { dependencies } = recorder();

    await expect(generate(["--locales", "xx"], {}, dependencies)).rejects.toThrow(
      /Unknown locale xx/,
    );
    await expect(generate(["--locales", "ja", "ja"], {}, dependencies)).rejects.toThrow(
      /Duplicate locale ja/,
    );
    await expect(generate(["--locales"], {}, dependencies)).rejects.toThrow(/at least one locale/);
    await expect(generate(["--locale", "ja"], {}, dependencies)).rejects.toThrow(
      /Unknown option --locale/,
    );
  });
});

describe("syncing through the Lurkloot entry point", () => {
  async function generated(version = "9.9.9") {
    const bundle = bundleDirectory();
    const root = bundleDirectory();
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    mkdirSync(join(root, "store-descriptions"));
    writeFileSync(join(root, "store-descriptions", "ja.txt"), "Japanese body\n");
    const paths = {
      packageRoot: root,
      build: "/not-built",
      bundle,
      descriptions: join(root, "store-descriptions"),
    };
    mkdirSync(join(bundle, "ja"), { recursive: true });
    writeFileSync(join(bundle, "ja", "description.txt"), "Japanese body\n");
    await stampBundle({
      dir: bundle,
      name: "lurkloot",
      source: { version },
      sections: ["ja/description"],
    });
    return { bundle, paths };
  }

  it("validates the bundle in the repository's own place with the checkout's version", async () => {
    const { paths } = await generated();

    await expect(main(["validate"], {}, { paths })).resolves.toBeUndefined();
  });

  it("refuses a description file that changed since the bundle was generated", async () => {
    const { paths } = await generated();
    writeFileSync(join(paths.descriptions, "ja.txt"), "Edited since\n");

    await expect(main(["validate"], {}, { paths })).rejects.toThrow(
      /store-descriptions\/ differs from the bundle for ja\. Run pnpm store:generate:descriptions/,
    );
  });

  it("does not look at descriptions it was not asked to sync", async () => {
    const { paths } = await generated();
    writeFileSync(join(paths.descriptions, "ja.txt"), "Edited since\n");
    const check = descriptionsAreFresh(paths);

    await expect(
      check({
        bundle: await readBundle(paths.bundle),
        locales: ["ja"],
        parts: { descriptions: false },
      }),
    ).resolves.toBeUndefined();
  });
});
