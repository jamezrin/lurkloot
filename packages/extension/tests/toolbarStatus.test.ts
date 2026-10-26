import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { describe, expect, it, vi } from "vitest";
import {
  createToolbarStatusApplier,
  deriveToolbarView,
  toolbarIconPaths,
  toolbarTitle,
  type ToolbarStatus,
} from "../src/core/toolbarStatus";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");
const EN = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@lurkloot/locales/messages/en.json"),
    "utf8",
  ),
) as Record<string, { message: string }>;

function settings(enabled: Partial<Record<Platform, boolean>>) {
  return {
    platform: {
      twitch: { enabled: enabled.twitch ?? false },
      kick: { enabled: enabled.kick ?? false },
    },
  } as Parameters<typeof deriveToolbarView>[0];
}

function state(patch: (draft: SchedulerState) => void = () => undefined): SchedulerState {
  const draft = structuredClone(DEFAULT_STATE);
  draft.authHealth.twitch = { status: "healthy" };
  draft.authHealth.kick = { status: "healthy" };
  patch(draft);
  return draft;
}

const BOTH = settings({ twitch: true, kick: true });

const englishTranslate = async (key: string, substitutions?: string | string[]) => {
  const values = substitutions === undefined ? [] : [substitutions].flat();
  return EN[key]!.message.replace(/\$(\d)/g, (_, index) => values[Number(index) - 1] ?? "");
};

describe("deriveToolbarView", () => {
  it("is off when no platform is enabled, whatever the state says", () => {
    const view = deriveToolbarView(
      settings({}),
      state((draft) => {
        draft.authHealth.kick = { status: "invalid_credentials" };
      }),
    );
    expect(view).toEqual({ status: "off", platforms: [] });
  });

  it("is idle when enabled platforms have nothing to watch", () => {
    expect(deriveToolbarView(BOTH, state()).status).toBe("idle");
  });

  it("is watching when any enabled platform is watching", () => {
    const view = deriveToolbarView(
      BOTH,
      state((draft) => {
        draft.sessions.kick.status = "watching";
      }),
    );
    expect(view.status).toBe("watching");
    expect(view.platforms).toEqual([
      { platform: "twitch", status: "idle" },
      { platform: "kick", status: "watching" },
    ]);
  });

  it("is paused by a manual-close pause or a paused session", () => {
    const closed = state((draft) => {
      draft.sessions.twitch.status = "watching";
      draft.manualClosePause = { kick: { platform: "kick", closedAt: "2026-10-25T00:00:00Z" } };
    });
    expect(deriveToolbarView(BOTH, closed).status).toBe("paused");
    const manual = state((draft) => {
      draft.sessions.twitch.status = "paused";
    });
    expect(deriveToolbarView(BOTH, manual).status).toBe("paused");
  });

  it.each([
    ["missing_credentials", "signed_out"],
    ["invalid_credentials", "signed_out"],
    ["blocked", "blocked"],
  ] as const)("reports %s auth as a problem even while another platform watches", (auth, line) => {
    const view = deriveToolbarView(
      BOTH,
      state((draft) => {
        draft.sessions.twitch.status = "watching";
        draft.authHealth.kick = { status: auth };
      }),
    );
    expect(view.status).toBe("problem");
    expect(view.platforms).toContainEqual({ platform: "kick", status: line });
  });

  it("reports a flagged critical failure as a problem", () => {
    const view = deriveToolbarView(
      BOTH,
      state((draft) => {
        draft.criticalHealth = {
          kick: {
            status: "flagged",
            failingMs: 0,
            failingTicks: 0,
            managedTabOpens: [],
            breakerOpen: false,
            records: [],
          },
        };
      }),
    );
    expect(view.status).toBe("problem");
    expect(view.platforms).toContainEqual({ platform: "kick", status: "stuck" });
  });

  // These recover on their own; surfacing them would make the "!" flap.
  it("does not treat transient auth or a session error as a problem", () => {
    const view = deriveToolbarView(
      BOTH,
      state((draft) => {
        draft.authHealth.twitch = { status: "checking" };
        draft.authHealth.kick = { status: "unavailable" };
        draft.sessions.kick.status = "error";
      }),
    );
    expect(view.status).toBe("idle");
  });

  it("ignores a disabled platform's problems", () => {
    const view = deriveToolbarView(
      settings({ twitch: true }),
      state((draft) => {
        draft.sessions.twitch.status = "watching";
        draft.authHealth.kick = { status: "missing_credentials" };
      }),
    );
    expect(view).toEqual({
      status: "watching",
      platforms: [{ platform: "twitch", status: "watching" }],
    });
  });
});

describe("toolbarTitle", () => {
  it("lists each enabled platform under the extension name", async () => {
    const view = deriveToolbarView(
      BOTH,
      state((draft) => {
        draft.sessions.twitch.status = "watching";
        draft.authHealth.kick = { status: "invalid_credentials" };
      }),
    );
    expect(await toolbarTitle(view, englishTranslate)).toBe(
      "Lurkloot\nTwitch: farming\nKick: signed out",
    );
  });

  it("says farming is off when nothing is enabled", async () => {
    expect(await toolbarTitle(deriveToolbarView(settings({}), state()), englishTranslate)).toBe(
      "Lurkloot\nFarming is off",
    );
  });
});

describe("toolbar icons", () => {
  it.each(["off", "idle", "watching", "paused", "problem"] satisfies ToolbarStatus[])(
    "ships every %s icon size",
    (status) => {
      for (const path of Object.values(toolbarIconPaths(status))) {
        expect(existsSync(join(PUBLIC_DIR, path))).toBe(true);
      }
    },
  );
});

describe("createToolbarStatusApplier", () => {
  function fakeAction() {
    return {
      setIcon: vi.fn(async (_details: { path: Record<string, string> }) => undefined),
      setTitle: vi.fn(async (_details: { title: string }) => undefined),
    };
  }

  it("writes the icon and title only when they change", async () => {
    const action = fakeAction();
    const applier = createToolbarStatusApplier(action, englishTranslate);
    const watching = state((draft) => {
      draft.sessions.kick.status = "watching";
    });
    await applier.apply(BOTH, watching);
    await applier.apply(BOTH, watching);
    expect(action.setIcon).toHaveBeenCalledTimes(1);
    expect(action.setIcon).toHaveBeenCalledWith({ path: toolbarIconPaths("watching") });
    expect(action.setTitle).toHaveBeenCalledTimes(1);

    applier.invalidate();
    await applier.apply(BOTH, watching);
    expect(action.setIcon).toHaveBeenCalledTimes(2);
  });

  it("applies views in call order", async () => {
    const action = fakeAction();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const slowTranslate = async (key: string, substitutions?: string | string[]) => {
      if (first) {
        first = false;
        await gate;
      }
      return englishTranslate(key, substitutions);
    };
    const applier = createToolbarStatusApplier(action, slowTranslate);
    const older = applier.apply(BOTH, state());
    const newer = applier.apply(settings({}), state());
    release();
    await Promise.all([older, newer]);
    expect(action.setIcon.mock.calls.at(-1)).toEqual([{ path: toolbarIconPaths("off") }]);
    expect(action.setTitle.mock.calls.at(-1)).toEqual([{ title: "Lurkloot\nFarming is off" }]);
  });

  it("swallows browser failures and tolerates a missing action API", async () => {
    const action = fakeAction();
    action.setIcon.mockRejectedValueOnce(new Error("no icon"));
    const applier = createToolbarStatusApplier(action, englishTranslate);
    await expect(applier.apply(BOTH, state())).resolves.toBeUndefined();
    await applier.apply(BOTH, state());
    expect(action.setIcon).toHaveBeenCalledTimes(2);

    await expect(
      createToolbarStatusApplier(undefined, englishTranslate).apply(BOTH, state()),
    ).resolves.toBeUndefined();
  });
});

describe("toolbar ownership", () => {
  // The icon reflects committed state only (#900): one module writes it.
  it("writes the toolbar icon, title and badge only from toolbarStatus.ts", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = ["src", "entrypoints"].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => join(root, dir, file)),
    );
    for (const file of sources) {
      if (file.endsWith("/src/core/toolbarStatus.ts")) continue;
      expect(readFileSync(file, "utf8").replace(/\/\/.*$/gm, ""), file).not.toMatch(
        /\.\s*(?:setIcon|setTitle|setBadgeText|setBadgeBackgroundColor)\s*\(/,
      );
    }
  });
});
