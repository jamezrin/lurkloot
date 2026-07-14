import { describe, expect, it, vi } from "vitest";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { TwitchHeartbeatStrategy } from "@lurkloot/core/twitch/heartbeat";

describe("Twitch heartbeat strategies", () => {
  it("delegates resolved stream and viewer identifiers to the injected strategy", async () => {
    const strategy: TwitchHeartbeatStrategy = {
      id: "test-heartbeat",
      tick: vi.fn(async () => ({ ok: true, live: true })),
    };
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      const operationName = JSON.parse(String(init?.body)).operationName;
      if (operationName === "StreamInfo") {
        return {
          data: {
            user: {
              id: "channel-id",
              stream: { id: "broadcast-id", game: { id: "game-id", name: "Game Name" } },
            },
          },
        };
      }
      throw new Error(`unexpected operation ${operationName}`);
    });
    const adapter = new TwitchAdapter(
      { fetchJson: fetchJson as never },
      undefined,
      undefined,
      { heartbeatStrategy: strategy },
    );
    const watcher = adapter.createTablessWatcher();
    const channel = {
      platform: "twitch" as const,
      username: "creator",
      url: "https://www.twitch.tv/creator",
    };

    await watcher.start(channel, { userId: "viewer-id" });
    await expect(watcher.tick({})).resolves.toEqual({ ok: true, live: true });

    expect(strategy.tick).toHaveBeenCalledOnce();
    expect(strategy.tick).toHaveBeenCalledWith({
      channel,
      broadcastId: "broadcast-id",
      channelId: "channel-id",
      userId: "viewer-id",
      gameId: "game-id",
      gameName: "Game Name",
    });
  });
});
