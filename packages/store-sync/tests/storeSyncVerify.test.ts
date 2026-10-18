import { describe, expect, it } from "vitest";
// @ts-expect-error The production utility is an executable JavaScript module.
import { main } from "../src/cli.mjs";
import {
  checkLocaleState,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../src/verify.mjs";
import { makeBundle, useTemporaryDirectories } from "./helpers/bundle";

useTemporaryDirectories();

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

const spec = {
  locales: { ja: { description: "Body", screenshots: 5 } },
  global: { screenshots: 5 },
};

class FakeDashboard {
  hasMutated = false;
  reloads = 0;
  closed = false;
  saved: string[] = [];
  pendingText = "";
  read: string[] = [];
  constructor(private readonly states: Record<string, State>) {}
  async openAndWaitForAuthentication() {}
  async preflight() {}
  async selectLocale() {}
  async setDescription(text: string) {
    this.hasMutated = true;
    this.pendingText = text;
    return true;
  }
  async saveDraft() {
    this.saved.push(this.pendingText);
  }
  async reload() {
    this.reloads += 1;
  }
  async readLocaleState(locale: string) {
    this.read.push(locale);
    return this.states[locale];
  }
}

async function run(
  args: string[],
  dashboard: FakeDashboard,
  options: { bundle?: Parameters<typeof makeBundle>[0] } = {},
) {
  const dir = await makeBundle(options.bundle ?? spec);
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
  const result = main([...args, "--bundle", dir], env, {
    output: (line: string) => lines.push(line),
    expectedVersion: "1.18.0",
    openBrowser: async () => session,
    createDashboard: () => dashboard,
    finishBrowser: async () => {},
    abandonBrowser: async () => {},
  });
  return { result, lines };
}

describe("readback", () => {
  it("passes when a fresh load shows the local description and a full localized group", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja" }) });

    const { result, lines } = await run(["verify"], dashboard);
    await result;

    expect(dashboard.reloads).toBe(1);
    expect(lines).toContain("ja: verified");
    expect(lines).toContain("global: verified");
    expect(lines.at(-1)).toMatch(/Verified 2 groups against a fresh load/);
  });

  it("fails naming the group and the difference when the dashboard disagrees", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Stale English body", localized: ids("l", 3) }),
    });

    const { result } = await run(["verify"], dashboard);

    await expect(result).rejects.toThrow(
      /ja: description differs.*expected 5 screenshots in the localized group, found 3/s,
    );
  });

  it("checks the shared group once, whichever language it was read from", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", global: ids("g", 4) }) });

    const { result } = await run(["verify"], dashboard);

    await expect(result).rejects.toThrow(
      /global: expected 5 screenshots in the global group, found 4/,
    );
  });

  it("reads the shared group alone through the first language when no language is named", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", localized: [] }) });

    const { result, lines } = await run(["verify", "--only", "global"], dashboard);
    await result;

    expect(dashboard.read).toEqual(["ja"]);
    expect(lines).toContain("global: verified");
    expect(lines).not.toContain("ja: verified");
  });

  it("compares only descriptions when asked", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", localized: [] }) });

    const { result } = await run(["verify", "--only", "descriptions"], dashboard);

    await expect(result).resolves.toBeUndefined();
  });

  it("does not require the artwork to match this checkout", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja" }) });

    const { result } = await run(["verify"], dashboard, { bundle: { ...spec, version: "1.17.2" } });

    await expect(result).resolves.toBeUndefined();
  });

  it("does not require a group the bundle gives no screenshots to be empty or full", async () => {
    const dashboard = new FakeDashboard({ en: state({ locale: "en", localized: [] }) });

    const { result } = await run(["verify", "--locales", "en"], dashboard, {
      bundle: { locales: { en: { description: "Body" } }, global: { screenshots: 5 } },
    });

    await expect(result).resolves.toBeUndefined();
  });

  it("reads back after a sync, and fails the run when the dashboard did not keep the text", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Something else" }),
    });

    const { result } = await run(["sync", "--only", "descriptions"], dashboard);

    await expect(result).rejects.toThrow(/Readback does not match the bundle/);
    expect(dashboard.saved).toEqual(["Body"]);
    expect(dashboard.reloads).toBe(1);
  });

  it("skips the readback only when told to, and says so", async () => {
    const dashboard = new FakeDashboard({
      ja: state({ locale: "ja", description: "Something else" }),
    });

    const { result, lines } = await run(
      ["sync", "--only", "descriptions", "--no-verify"],
      dashboard,
    );
    await result;

    expect(dashboard.reloads).toBe(0);
    expect(lines.join("\n")).toMatch(/Skipped the readback/);
  });

  it("closes the tab it opened in the operator's Chrome after a clean run", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja" }) });

    await (await run(["verify"], dashboard)).result;

    expect(dashboard.closed).toBe(true);
  });

  it("leaves the tab open when the run fails, so the draft can be looked at", async () => {
    const dashboard = new FakeDashboard({ ja: state({ locale: "ja", localized: [] }) });

    await (await run(["verify"], dashboard)).result.catch(() => {});

    expect(dashboard.closed).toBe(false);
  });
});

describe("expected state per locale", () => {
  it("ignores line-ending and trailing-whitespace differences in a description", () => {
    const problems = checkLocaleState({
      state: state({ locale: "ja", description: "One\r\n\r\nTwo\n" }),
      expectedDescription: "One\n\nTwo",
    });

    expect(problems).toEqual([]);
  });

  it("expects exactly the screenshots the bundle holds in the localized group", () => {
    expect(
      checkLocaleState({ state: state({ locale: "ja", localized: [] }), expectedScreenshots: 5 }),
    ).toEqual(["expected 5 screenshots in the localized group, found 0"]);
    expect(
      checkLocaleState({
        state: state({ locale: "ja", localized: ids("l", 3) }),
        expectedScreenshots: 3,
      }),
    ).toEqual([]);
    expect(
      checkLocaleState({
        state: state({ locale: "ja", localized: ["a"] }),
        expectedScreenshots: 1,
      }),
    ).toEqual([]);
  });

  it("checks nothing it has no expectation for", () => {
    expect(
      checkLocaleState({ state: state({ locale: "ja", localized: [], description: "" }) }),
    ).toEqual([]);
  });

  it("flags one image shown twice", () => {
    expect(
      checkLocaleState({
        state: state({ locale: "ja", localized: ["a", "a", "b", "c", "d"] }),
        expectedScreenshots: 5,
      }),
    ).toEqual(["the localized group shows the same image more than once"]);
  });
});
