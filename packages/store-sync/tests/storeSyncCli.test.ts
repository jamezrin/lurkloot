import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBundle,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/bundle.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../src/cli.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { resolveScope } from "../src/scope.mjs";
import {
  SOURCE,
  makeBundle,
  temporaryDirectory,
  useTemporaryDirectories,
  writeSection,
} from "./helpers/bundle";

useTemporaryDirectories();

const extensionId = "aobaackpofkghaejdnnmpmeaiaoibhdn";
const env = {
  CWS_EXTENSION_ID: extensionId,
  CWS_PUBLISHER_ID: "12345678-1234-1234-1234-123456789abc",
};

const spec = {
  locales: {
    ja: { description: "Japanese body", screenshots: 5 },
    id: { description: "Indonesian body", screenshots: 3 },
  },
  global: { screenshots: 5, promo: true },
};

// Records what the sync asked of the dashboard and answers like a healthy page.
function fakeDashboard(calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    hasMutated: false,
    images: new Map<string, string[]>(),
    selected: "",
    async openAndWaitForAuthentication() {
      calls.push("authenticated");
    },
    async preflight() {
      calls.push("preflight");
    },
    async selectLocale(locale: string) {
      this.selected = locale;
    },
    async setDescription() {
      this.hasMutated = true;
      calls.push("description");
      return true;
    },
    group(section = "localized") {
      const key = section === "global" ? "global" : this.selected;
      if (!this.images.has(key)) this.images.set(key, []);
      return this.images.get(key) as string[];
    },
    async requireDistinctScreenshotSections() {},
    async thumbnailIds(section?: string) {
      return [...this.group(section)];
    },
    async screenshotCount(section?: string) {
      return this.group(section).length;
    },
    async removeFirstScreenshot(section?: string) {
      this.group(section).shift();
    },
    async waitForScreenshotCount() {},
    async uploadScreenshot(path: string, section?: string) {
      this.hasMutated = true;
      this.group(section).push(path);
    },
    async saveDraft() {
      calls.push("saved");
    },
    ...overrides,
  };
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    ownsBrowser: false,
    browser: { close: async () => {} },
    context: { newPage: async () => ({ close: async () => {} }) },
    ...overrides,
  };
}

async function sync(args: string[], dependencies: Record<string, unknown> = {}, bundle = spec) {
  const dir = await makeBundle(bundle);
  const lines: string[] = [];
  const result = main([...args, "--bundle", dir], env, {
    output: (line: string) => lines.push(line),
    expectedVersion: "1.18.0",
    finishBrowser: async () => {},
    abandonBrowser: async () => {},
    ...dependencies,
  });
  return { dir, lines, result };
}

describe("choosing a command", () => {
  it("needs a known command, and accepts the -- that pnpm passes through", async () => {
    await expect(main([], env, {})).rejects.toThrow(/Usage: store-sync/);
    await expect(main(["frobnicate"], env, {})).rejects.toThrow(/Usage: store-sync/);
    const { result } = await sync(["--", "validate"].slice(1));
    await expect(result).resolves.toBeUndefined();
  });

  it("rejects an option it does not know instead of ignoring it", async () => {
    await expect(sync(["validate", "--locale", "ja"]).then(({ result }) => result)).rejects.toThrow(
      /Unknown option --locale/,
    );
  });
});

describe("checking before a browser starts", () => {
  it("rejects an invalid extension ID before reading the bundle", async () => {
    let reads = 0;

    await expect(
      main(
        ["sync"],
        { CWS_EXTENSION_ID: "../../another-item" },
        {
          readBundle: async () => {
            reads += 1;
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/32-character Chrome extension ID/i);
    expect(reads).toBe(0);
  });

  it("refuses a bundle that does not match its stamp before launching", async () => {
    const dir = await makeBundle(spec);
    writeSection(dir, "ja", "screenshots", 5, "edited");
    let launches = 0;

    await expect(
      main(["sync", "--bundle", dir], env, {
        openBrowser: async () => {
          launches += 1;
        },
        output: () => {},
      }),
    ).rejects.toThrow(/does not match its stamp/);
    expect(launches).toBe(0);
  });

  it("validates without a browser and without any dashboard identity", async () => {
    let launches = 0;
    const { result, lines } = await sync(["validate"], {
      openBrowser: async () => {
        launches += 1;
      },
    });

    await result;

    expect(launches).toBe(0);
    expect(lines.join("\n")).toMatch(/Validated 13 screenshots for 3 groups\./);
    expect(lines.join("\n")).toMatch(/Validated 2 descriptions\./);
  });

  it("requires a publisher ID before browser launch", async () => {
    const dir = await makeBundle(spec);
    let launches = 0;

    await expect(
      main(
        ["sync", "--bundle", dir],
        { CWS_EXTENSION_ID: extensionId },
        {
          expectedVersion: "1.18.0",
          openBrowser: async () => {
            launches += 1;
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/CWS_PUBLISHER_ID/i);
    await expect(
      main(
        ["sync", "--bundle", dir],
        { ...env, CWS_PUBLISHER_ID: "../../other" },
        {
          expectedVersion: "1.18.0",
          openBrowser: async () => {
            launches += 1;
          },
          output: () => {},
        },
      ),
    ).rejects.toThrow(/publisher.*UUID/i);
    expect(launches).toBe(0);
  });

  it("refuses a bundle made for another extension", async () => {
    const { result } = await sync(["validate"], {}, {
      ...spec,
      extensionId: "b".repeat(32),
    } as never);

    await expect(result).rejects.toThrow(/is for extension b+, but CWS_EXTENSION_ID is/);
  });

  it("runs the producer's own checks and stops on the first that fails", async () => {
    const seen: string[] = [];
    const { result } = await sync(["validate"], {
      checks: [
        async ({ locales }: { locales: string[] }) => {
          seen.push(locales.join(","));
        },
        async () => {
          throw new Error("descriptions are stale");
        },
        async () => {
          seen.push("never");
        },
      ],
    });

    await expect(result).rejects.toThrow(/descriptions are stale/);
    expect(seen).toEqual(["id,ja"]);
  });

  it("says plainly that promo tiles in the bundle are not uploaded", async () => {
    const { result, lines } = await sync(["validate"]);
    await result;

    expect(lines.join("\n")).toMatch(
      /promo tiles for global are in the bundle but are not uploaded/,
    );
  });
});

describe("artwork provenance", () => {
  it("refuses artwork from another version before launching, and accepts it when told to", async () => {
    let launches = 0;
    const base = { openBrowser: async () => ((launches += 1), fakeSession()) };

    const refused = await sync(["validate"], base, { ...spec, version: "1.17.2" } as never);
    await expect(refused.result).rejects.toThrow(
      /generated from 1\.17\.2, but this checkout is 1\.18\.0/,
    );
    const accepted = await sync(["validate", "--allow-version-mismatch"], base, {
      ...spec,
      version: "1.17.2",
    } as never);
    await expect(accepted.result).resolves.toBeUndefined();
    expect(launches).toBe(0);
  });

  it("lets --expect-version stand in for the version the wrapper supplies", async () => {
    const { result } = await sync(["validate", "--expect-version", "1.17.2"], {}, {
      ...spec,
      version: "1.17.2",
    } as never);

    await expect(result).resolves.toBeUndefined();
  });

  it("refuses a dirty capture unless told otherwise", async () => {
    const refused = await sync(["validate"], {}, { ...spec, dirty: true } as never);
    await expect(refused.result).rejects.toThrow(/uncommitted changes/);
    const accepted = await sync(["validate", "--allow-dirty"], {}, {
      ...spec,
      dirty: true,
    } as never);
    await expect(accepted.result).resolves.toBeUndefined();
  });

  it("does not look at artwork provenance for a descriptions-only run", async () => {
    const { result } = await sync(["validate", "--only", "descriptions"], {}, {
      ...spec,
      version: "1.17.2",
      dirty: true,
    } as never);

    await expect(result).resolves.toBeUndefined();
  });
});

describe("what a run touches", () => {
  async function scope(options: Record<string, unknown>) {
    return resolveScope({ bundle: await readBundle(await makeBundle(spec)), ...options });
  }

  it("takes every language and the shared group when nothing is narrowed", async () => {
    expect(await scope({})).toEqual({
      locales: ["id", "ja"],
      parts: { descriptions: true, screenshots: true, global: true },
    });
  });

  it("leaves the shared group out when a language is named, unless it is asked for", async () => {
    expect((await scope({ requestedLocales: ["ja"] })).parts.global).toBe(false);
    expect((await scope({ requestedLocales: ["ja"], withGlobal: true })).parts.global).toBe(true);
  });

  it("narrows to one part", async () => {
    expect((await scope({ only: "global" })).parts).toEqual({
      descriptions: false,
      screenshots: false,
      global: true,
    });
  });

  it("refuses a locale the bundle does not have, and a part it does not have", async () => {
    await expect(scope({ requestedLocales: ["fr"] })).rejects.toThrow(
      /Locale fr is not in the bundle\. It has: id, ja/,
    );
    await expect(scope({ requestedLocales: ["ja", "ja"] })).rejects.toThrow(/Duplicate locale ja/);
    await expect(scope({ only: "everything" })).rejects.toThrow(/--only expects one of/);
    const bare = await readBundle(await makeBundle({ locales: { ja: { description: "x" } } }));
    expect(() => resolveScope({ bundle: bare, only: "global" })).toThrow(/no global screenshots/);
    expect(() => resolveScope({ bundle: bare, only: "screenshots" })).toThrow(
      /no screenshots for ja/,
    );
  });
});

describe("syncing", () => {
  it("reuses the attached browser's context and finishes the session after a complete draft save", async () => {
    let finished = false;
    let newContexts = 0;
    const calls: string[] = [];
    const { result } = await sync(["sync", "--locales", "ja", "--no-verify"], {
      openBrowser: async () =>
        fakeSession({
          ownsBrowser: true,
          browser: {
            newContext: async () => {
              newContexts += 1;
            },
          },
        }),
      createDashboard: () => fakeDashboard(calls),
      finishBrowser: async () => {
        finished = true;
      },
    });
    await result;

    expect(calls).toEqual(["authenticated", "preflight", "description", "saved", "saved"]);
    expect(newContexts).toBe(0);
    expect(finished).toBe(true);
  });

  it("opens the Chrome profile named for what is being synced", async () => {
    let profileApp = "";
    const { result } = await sync(
      ["sync", "--locales", "ja", "--only", "descriptions", "--no-verify"],
      {
        openBrowser: async (options: { profileApp: string }) => {
          profileApp = options.profileApp;
          return fakeSession();
        },
        createDashboard: () => fakeDashboard([]),
      },
    );
    await result;

    expect(profileApp).toBe("acme");
  });

  it("keeps the signed-in browser when preflight fails before mutation", async () => {
    const abandoned: unknown[] = [];
    const dashboard = fakeDashboard([], {
      async preflight() {
        throw new Error("selector missing");
      },
    });
    const { result } = await sync(["sync", "--locales", "ja"], {
      openBrowser: async () => fakeSession(),
      createDashboard: () => dashboard,
      abandonBrowser: async (_session: unknown, _output: unknown, options: unknown) => {
        abandoned.push(options);
      },
    });

    await expect(result).rejects.toThrow(/preflight: selector missing/);
    expect(abandoned).toEqual([{ mutated: false }]);
  });

  it("keeps the browser when the sign-in wait itself fails", async () => {
    const abandoned: unknown[] = [];
    const { result } = await sync(["sync", "--locales", "ja"], {
      openBrowser: async () => fakeSession(),
      createDashboard: () =>
        fakeDashboard([], {
          async openAndWaitForAuthentication() {
            throw new Error("timed out waiting for sign-in");
          },
        }),
      abandonBrowser: async (_session: unknown, _output: unknown, options: unknown) => {
        abandoned.push(options);
      },
    });

    await expect(result).rejects.toThrow(/timed out waiting for sign-in/);
    expect(abandoned).toEqual([{ mutated: false }]);
  });

  it("abandons the session so a partially changed draft stays open after a mutation failure", async () => {
    const abandoned: unknown[] = [];
    const dashboard = fakeDashboard([], {
      async saveDraft() {
        throw new Error("save rejected");
      },
    });
    const { result } = await sync(["sync", "--locales", "ja", "--only", "descriptions"], {
      openBrowser: async () => fakeSession(),
      createDashboard: () => dashboard,
      abandonBrowser: async (_session: unknown, _output: unknown, options: unknown) => {
        abandoned.push(options);
      },
    });

    await expect(result).rejects.toThrow(/save rejected/);
    expect(abandoned).toEqual([{ mutated: true }]);
  });

  it("retries with the wrapper's own command", async () => {
    const dashboard = fakeDashboard([], {
      async setDescription() {
        throw new Error("field gone");
      },
    });
    const { result } = await sync(["sync", "--locales", "ja", "--only", "descriptions"], {
      invocation: "pnpm store:sync",
      openBrowser: async () => fakeSession(),
      createDashboard: () => dashboard,
    });

    await expect(result).rejects.toThrow(/Retry with: pnpm store:sync --locales ja/);
  });
});

describe("snapshot and stamp", () => {
  it("opens the profile the wrapper names, since a snapshot has no bundle to name it", async () => {
    let profileApp = "";
    const dir = temporaryDirectory();
    await main(["snapshot", "--locales", "en", "--out", dir], env, {
      output: () => {},
      profileApp: "lurkloot",
      openBrowser: async (options: { profileApp: string }) => {
        profileApp = options.profileApp;
        return fakeSession();
      },
      createDashboard: () => ({
        openAndWaitForAuthentication: async () => {},
        selectLocale: async () => {},
        snapshotHtml: async () => "<html></html>",
      }),
      finishBrowser: async () => {},
    });

    expect(profileApp).toBe("lurkloot");
  });

  it("will not snapshot without being told which languages", async () => {
    await expect(main(["snapshot"], env, {})).rejects.toThrow(/needs --locales/i);
  });

  it("writes one sanitized file per requested language", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-sync-snapshots-"));
    const selected: string[] = [];
    try {
      await main(["snapshot", "--locales", "en", "es", "--out", dir], env, {
        output: () => {},
        openBrowser: async () => fakeSession(),
        createDashboard: () => ({
          openAndWaitForAuthentication: async () => {},
          selectLocale: async (locale: string) => selected.push(locale),
          snapshotHtml: async () => `<html>${selected.at(-1)}</html>`,
        }),
        finishBrowser: async () => {},
      });

      expect(readdirSync(dir).sort()).toEqual(["en.html", "es.html"]);
      expect(readFileSync(join(dir, "es.html"), "utf8")).toBe("<html>es</html>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stamps what a producer wrote, for producers that are not JavaScript", async () => {
    const dir = temporaryDirectory();
    writeSection(dir, "ja", "screenshots", 2);
    writeSection(dir, "ja", "description");
    const lines: string[] = [];

    await main(
      [
        "stamp",
        "--bundle",
        dir,
        "--name",
        "acme",
        "--version",
        SOURCE.version,
        "--commit",
        SOURCE.commit,
        "--sections",
        "ja/screenshots",
        "ja/description",
      ],
      env,
      { output: (line: string) => lines.push(line) },
    );

    expect((await readBundle(dir)).scope("ja").screenshots).toHaveLength(2);
    expect(lines).toEqual([`Stamped 2 sections in ${dir}.`]);
  });
});
