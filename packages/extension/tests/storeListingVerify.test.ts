import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../scripts/store-listing/cli.mjs";
import {
  checkLocaleState,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../scripts/store-listing/core/verify.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { LISTING } from "../scripts/store-listing/lurkloot.mjs";

const env = {
  CWS_EXTENSION_ID: "aobaackpofkghaejdnnmpmeaiaoibhdn",
  CWS_PUBLISHER_ID: "12345678-1234-1234-1234-123456789abc",
};
const ids = (prefix: string, count = 5) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

type State = {
  locale: string;
  description: string;
  localized: string[];
  global: string[];
};

function state(overrides: Partial<State> & { locale: string }): State {
  return { description: "Body", localized: ids("l"), global: ids("g"), ...overrides };
}

class FakeDashboard {
  hasMutated = false;
  reloads = 0;
  closed = false;
  saved: string[] = [];
  constructor(private readonly states: Record<string, State>) {}
  async openAndWaitForAuthentication() {}
  async preflight() {}
  async selectLocale() {}
  async setDescription(text: string) {
    this.hasMutated = true;
    this.pendingText = text;
    return true;
  }
  pendingText = "";
  async saveDraft() {
    this.saved.push(this.pendingText);
  }
  async reload() {
    this.reloads += 1;
  }
  async readLocaleState(locale: string) {
    return this.states[locale];
  }
}

function run(args: string[], dashboard: FakeDashboard, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const session = {
    ownsBrowser: false,
    browser: { close: async () => {} },
    context: {
      newPage: async () => ({
        close: async () => {
          dashboard.closed = true;
        },
      }),
    },
  };
  const result = main(args, env, {
    output: (line: string) => lines.push(line),
    checkProvenance: async () => {},
    loadDescriptions: async () => new Map([["ja", "Body"]]),
    validateFiles: async () => new Map(),
    openBrowser: async () => session,
    createDashboard: () => dashboard,
    finishBrowser: async () => {},
    abandonBrowser: async () => {},
    ...extra,
  });
  return { result, lines };
}

describe("readback", () => {
  it("passes when a fresh load shows the local description and a full localized group", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja" }) });

    const { result, lines } = run(["verify", "--locales", "ja"], dashboard);
    await result;

    expect(dashboard.reloads).toBe(1);
    expect(lines).toContain("ja: verified");
    expect(lines.at(-1)).toMatch(/Verified 1 locale against a fresh load/);
  });

  it("fails naming the locale and the difference when the dashboard disagrees", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Stale English body", localized: ids("l", 3) }),
    });

    const { result } = run(["verify", "--locales", "ja"], dashboard);

    await expect(result).rejects.toThrow(
      /ja: description differs.*expected 5 screenshots in the localized group, found 3/s,
    );
  });

  it("compares only descriptions when asked", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", localized: [] }) });

    const { result } = run(["verify", "--only", "descriptions", "--locales", "ja"], dashboard);

    await expect(result).resolves.toBeUndefined();
  });

  it("reads back after a sync, and fails the run when the dashboard did not keep the text", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Something else" }),
    });

    const { result } = run(["sync", "--only", "descriptions", "--locales", "ja"], dashboard);

    await expect(result).rejects.toThrow(/Readback does not match the local files/);
    expect(dashboard.saved).toEqual(["Body"]);
    expect(dashboard.reloads).toBe(1);
  });

  it("skips the readback only when told to, and says so", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Something else" }),
    });

    const { result, lines } = run(
      ["sync", "--only", "descriptions", "--no-verify", "--locales", "ja"],
      dashboard,
    );
    await result;

    expect(dashboard.reloads).toBe(0);
    expect(lines.join("\n")).toMatch(/Skipped the readback/);
  });

  it("closes the tab it opened in the operator's Chrome after a clean run", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja" }) });

    await run(["verify", "--locales", "ja"], dashboard).result;

    expect(dashboard.closed).toBe(true);
  });

  it("leaves the tab open when the run fails, so the draft can be looked at", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", localized: [] }) });

    await run(["verify", "--locales", "ja"], dashboard).result.catch(() => {});

    expect(dashboard.closed).toBe(false);
  });
});

describe("expected state per locale", () => {
  const listing = LISTING;

  it("ignores line-ending and trailing-whitespace differences in a description", () => {
    const problems = checkLocaleState({
      listing,
      state: state({ locale: "ja", description: "One\r\n\r\nTwo\n" }),
      expectedDescription: "One\n\nTwo",
    });

    expect(problems).toEqual([]);
  });

  it("expects the source locale's artwork in the shared group, not the localized one", () => {
    const english = state({ locale: "en", localized: [] });

    expect(checkLocaleState({ listing, state: english, expectedScreenshots: 5 })).toEqual([]);
    expect(
      checkLocaleState({
        listing,
        state: { ...english, global: ids("g", 4) },
        expectedScreenshots: 5,
      }),
    ).toEqual(["expected 5 screenshots in the global group, found 4"]);
  });

  it("expects every other locale's own images in its localized group", () => {
    const problems = checkLocaleState({
      listing,
      state: state({ locale: "ja", localized: [] }),
      expectedScreenshots: 5,
    });

    expect(problems).toEqual(["expected 5 screenshots in the localized group, found 0"]);
  });

  it("flags one image shown twice", () => {
    const problems = checkLocaleState({
      listing,
      state: state({ locale: "ja", localized: ["a", "a", "b", "c", "d"] }),
      expectedScreenshots: 5,
    });

    expect(problems).toEqual(["the localized group shows the same image more than once"]);
  });
});
