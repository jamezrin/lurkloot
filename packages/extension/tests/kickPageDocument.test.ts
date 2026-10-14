import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelCandidate } from "@lurkloot/shared/models";
import { createTabRegistry, type TabRegistry } from "@lurkloot/core/tabRegistry";
import { KickWafBlockedError } from "@lurkloot/core/transport";
import { assertKickWatchTabUsable, isKickPageContextUsable } from "../src/core/kickPageDocument";

let registry: TabRegistry;
beforeEach(() => {
  registry = createTabRegistry();
});

function browserMock() {
  return {
    tabs: {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      remove: vi.fn<(tabId: number) => Promise<void>>(async () => undefined),
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 9 })),
    },
  };
}

const kickChannel: ChannelCandidate = {
  platform: "kick",
  username: "floridaboy",
  url: "https://kick.com/floridaboy",
};

describe("kickPageDocument", () => {
  it("rejects a Kick watch tab that shows a security-policy document (#794)", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{
          result: {
            usable: false,
            failure: {
              kind: "security_policy_blocked",
              reason: "Request blocked by security policy.",
              reference: "c0e117f5",
            },
          },
        }]),
      },
    };

    const error = await assertKickWatchTabUsable(
      registry,
      browser,
      9,
      kickChannel,
      undefined,
      undefined,
      { closeOnFailure: true },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KickWafBlockedError);
    if (!(error instanceof KickWafBlockedError)) throw new Error("Expected KickWafBlockedError");
    expect(error.failure).toEqual({
      kind: "security_policy_blocked",
      reason: "Request blocked by security policy.",
      reference: "c0e117f5",
    });
    expect(browser.tabs.remove).toHaveBeenCalledWith(9);
  });

  it("closes a reused Kick watch tab when Kick serves a security-policy document (#794)", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{
          result: {
            usable: false,
            failure: {
              kind: "security_policy_blocked",
              reason: "Request blocked by security policy.",
              reference: "c0e117f5",
            },
          },
        }]),
      },
    };

    await expect(assertKickWatchTabUsable(
      registry,
      browser,
      4,
      kickChannel,
      undefined,
      undefined,
      { closeOnFailure: true },
    )).rejects.toBeInstanceOf(KickWafBlockedError);

    expect(browser.tabs.remove).toHaveBeenCalledWith(4);
  });

  it("treats a Kick page-context document with WAF JSON as unusable", async () => {
    const browser = {
      ...browserMock(),
      scripting: {
        executeScript: vi.fn(async () => [{
          result: {
            usable: false,
            failure: { kind: "security_policy_blocked", reason: "Request blocked by security policy." },
          },
        }]),
      },
    };

    await expect(isKickPageContextUsable(browser, 14, "https://kick.com")).resolves.toBe(false);
  });

  it("ignores non-Kick channels", async () => {
    const browser = browserMock();
    await expect(assertKickWatchTabUsable(
      registry,
      browser,
      9,
      { platform: "twitch", username: "creator", url: "https://www.twitch.tv/creator" },
    )).resolves.toBeUndefined();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });
});
