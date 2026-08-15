import { describe, expect, it, vi } from "vitest";
import type { PageFetcher } from "@lurkloot/core/adapter";
import type { DropCampaign, EngineSettings } from "@lurkloot/shared/models";
import { applySettingsPatch, DEFAULT_ENGINE_SETTINGS, DEFAULT_SETTINGS, mergeEngineSettings } from "@lurkloot/shared/settings";
import { twitchAdapter } from "./helpers/adapters";

// Regression coverage for #400: Twitch's own discovery sources (the
// GameDirectory DROPS_ENABLED filter and a campaign's channel ACL) are trusted
// by default, because DropsHighlightService_AvailableDrops routinely omits a
// campaign that is in fact farmable and rejected every candidate.

function jsonFetcher(handler: (url: string, init?: RequestInit) => unknown): PageFetcher {
  const fetchJson = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => handler(url, init));
  return { fetchJson: fetchJson as PageFetcher["fetchJson"] };
}

// Records every GQL operation the adapter sends, batched or single.
function recordingFetcher(operations: string[], respond: (operationName: string, entry: Record<string, unknown>) => unknown): PageFetcher {
  return jsonFetcher((_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
    const entries = Array.isArray(body) ? body : [body];
    for (const entry of entries) operations.push(String(entry.operationName));
    const responses = entries.map((entry) => respond(String(entry.operationName), entry));
    return Array.isArray(body) ? responses : responses[0];
  });
}

const CAMPAIGN = { id: "campaign", name: "Campaign", categoryId: "game" } as DropCampaign;

// A live stream in the campaign's category, with an AvailableDrops response
// that omits the campaign entirely — the exact shape that stalled farming.
function respondWithOmittedCampaign(operationName: string, entry: Record<string, unknown>): unknown {
  if (operationName === "StreamInfo") {
    const channel = String((entry.variables as { channel?: string }).channel);
    return {
      data: {
        user: {
          id: `${channel}-id`,
          displayName: channel,
          stream: { id: `${channel}-broadcast`, game: { id: "game", name: "Game" }, viewersCount: 100 },
        },
      },
    };
  }
  if (operationName === "DropsHighlightService_AvailableDrops") {
    const channelID = String((entry.variables as { channelID?: string }).channelID);
    return { data: { channel: { id: channelID, viewerDropCampaigns: [{ id: "some-other-campaign" }] } } };
  }
  return { data: {} };
}

function directoryCandidate(username: string) {
  return {
    platform: "twitch" as const,
    username,
    url: `https://www.twitch.tv/${username}`,
    channelId: `${username}-id`,
    broadcastId: `${username}-broadcast`,
    categoryId: "game",
    live: true,
    // A GameDirectory result, not a campaign ACL entry.
    isAclMatch: false,
  };
}

function aclCandidate(username: string) {
  return {
    platform: "twitch" as const,
    username,
    url: `https://www.twitch.tv/${username}`,
    isAclMatch: true,
  };
}

describe("twitch campaign availability trust (#400)", () => {
  it("accepts a directory candidate whose AvailableDrops omits the campaign", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).selectCandidateChannel?.([directoryCandidate("directory-one")], CAMPAIGN);

    expect(selection?.channel?.username).toBe("directory-one");
    expect(operations).not.toContain("DropsHighlightService_AvailableDrops");
  });

  it("accepts an ACL candidate that is live in the campaign category", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).selectCandidateChannel?.([aclCandidate("acl-one")], CAMPAIGN);

    expect(selection?.channel?.username).toBe("acl-one");
    // Liveness/category still has to be confirmed for an ACL candidate.
    expect(operations).toContain("StreamInfo");
    expect(operations).not.toContain("DropsHighlightService_AvailableDrops");
  });

  it("rejects an offline ACL candidate even with strict validation off", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, (operationName, entry) => {
        if (operationName === "StreamInfo") {
          const channel = String((entry.variables as { channel?: string }).channel);
          return { data: { user: { id: `${channel}-id`, displayName: channel, stream: null } } };
        }
        return { data: {} };
      }),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).selectCandidateChannel?.([aclCandidate("offline-acl")], CAMPAIGN);

    expect(selection?.channel).toBeUndefined();
  });

  it("rejects a live ACL candidate streaming a different category", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, (operationName, entry) => {
        if (operationName === "StreamInfo") {
          const channel = String((entry.variables as { channel?: string }).channel);
          return {
            data: {
              user: {
                id: `${channel}-id`,
                displayName: channel,
                stream: { id: `${channel}-broadcast`, game: { id: "other-game", name: "Other" }, viewersCount: 5 },
              },
            },
          };
        }
        return { data: {} };
      }),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).selectCandidateChannel?.([aclCandidate("wrong-category")], CAMPAIGN);

    expect(selection?.channel).toBeUndefined();
  });

  // The winner-fallback path calls checkChannel(), which runs its own
  // single AvailableDrops request. A candidate without a channelId is the only
  // way to reach it, so a fixture with channelId set would pass while this
  // path stayed un-gated.
  it("issues no AvailableDrops request for a candidate lacking a channelId", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).selectCandidateChannel?.([{
      platform: "twitch" as const,
      username: "no-channel-id",
      url: "https://www.twitch.tv/no-channel-id",
      categoryId: "game",
      live: true,
      isAclMatch: false,
    }], CAMPAIGN);

    expect(selection?.channel?.username).toBe("no-channel-id");
    expect(operations).not.toContain("DropsHighlightService_AvailableDrops");
  });

  // checkChannel also re-verifies the channel already being watched
  // (scheduler.ts), so an un-gated negative there stops farming mid-session.
  it("does not fail an in-session channel re-check on omitted availability", async () => {
    const operations: string[] = [];
    const check = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      { strictCampaignAvailability: false },
    ).checkChannel({
      platform: "twitch",
      username: "watching",
      url: "https://www.twitch.tv/watching",
      channelId: "watching-id",
      broadcastId: "watching-broadcast",
      categoryId: "game",
      isAclMatch: false,
    }, { campaign: CAMPAIGN });

    expect(check.live).toBe(true);
    expect(check.categoryMatches).toBe(true);
    expect(check.campaignMatches).not.toBe(false);
    expect(operations).not.toContain("DropsHighlightService_AvailableDrops");
  });

  it("still batches AvailableDrops and rejects a mismatch in strict mode", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      { strictCampaignAvailability: true },
    ).selectCandidateChannel?.([directoryCandidate("directory-one")], CAMPAIGN);

    expect(selection?.channel).toBeUndefined();
    expect(operations).toContain("DropsHighlightService_AvailableDrops");
  });

  it("accepts a strict-mode candidate whose AvailableDrops lists the campaign", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, (operationName, entry) => {
        if (operationName === "DropsHighlightService_AvailableDrops") {
          const channelID = String((entry.variables as { channelID?: string }).channelID);
          return { data: { channel: { id: channelID, viewerDropCampaigns: [{ id: "campaign" }] } } };
        }
        return respondWithOmittedCampaign(operationName, entry);
      }),
      undefined,
      undefined,
      { strictCampaignAvailability: true },
    ).selectCandidateChannel?.([directoryCandidate("directory-one")], CAMPAIGN);

    expect(selection?.channel?.username).toBe("directory-one");
    expect(operations).toContain("DropsHighlightService_AvailableDrops");
  });

  it("defaults to trusting discovery sources when the option is omitted", async () => {
    const operations: string[] = [];
    const selection = await twitchAdapter(
      recordingFetcher(operations, respondWithOmittedCampaign),
      undefined,
      undefined,
      // Deliberately overrides the test helper's strict default back to the
      // production default so the shipped behaviour is what gets asserted.
      { strictCampaignAvailability: DEFAULT_ENGINE_SETTINGS.platform.twitch.strictCampaignAvailability },
    ).selectCandidateChannel?.([directoryCandidate("directory-one")], CAMPAIGN);

    expect(selection?.channel?.username).toBe("directory-one");
    expect(operations).not.toContain("DropsHighlightService_AvailableDrops");
  });
});

describe("strict campaign availability setting", () => {
  it("defaults to false", () => {
    expect(DEFAULT_ENGINE_SETTINGS.platform.twitch.strictCampaignAvailability).toBe(false);
  });

  // An existing install persisted before this setting existed has no such
  // property, and must keep farming on trusted discovery sources.
  // Cast because the persisted shape being simulated predates the property, so
  // it is deliberately not assignable to the current settings type.
  const persisted = (twitch: Record<string, unknown>) =>
    ({ platform: { twitch } }) as unknown as Partial<EngineSettings>;

  it("normalizes a missing persisted property to false", () => {
    expect(mergeEngineSettings(persisted({ enabled: true })).platform.twitch.strictCampaignAvailability).toBe(false);
  });

  it("preserves an explicitly enabled persisted value", () => {
    expect(mergeEngineSettings(persisted({ strictCampaignAvailability: true })).platform.twitch.strictCampaignAvailability).toBe(true);
  });

  it("round-trips through a settings patch", () => {
    const patched = applySettingsPatch(DEFAULT_SETTINGS, {
      platform: { twitch: { strictCampaignAvailability: true } },
    });
    expect(patched.platform.twitch.strictCampaignAvailability).toBe(true);
    // Kick is untouched by a Twitch-only setting.
    expect(patched.platform.kick).toEqual(DEFAULT_SETTINGS.platform.kick);
    expect(mergeEngineSettings(patched).platform.twitch.strictCampaignAvailability).toBe(true);
  });
});
