import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_ORIGIN_RULE_IDS,
  installPlatformOriginRules,
  platformOriginRules,
  platformSocketOrigin,
} from "../src/core/platformRequestOrigin";

describe("platform request origin rules", () => {
  const rules = platformOriginRules("abcdefghijklmnop");
  const rule = (id: number) => rules.find((candidate) => candidate.id === id)!;

  it("installs one request rule and one socket rule per platform", () => {
    expect(rules.map((candidate) => candidate.id).sort()).toEqual([...PLATFORM_ORIGIN_RULE_IDS]);
    for (const candidate of rules) {
      // Only the extension's own requests: a platform page's requests have the
      // platform as initiator and are never touched.
      expect(candidate.condition.initiatorDomains).toEqual(["abcdefghijklmnop"]);
    }
  });

  it("sets each platform's site origin on the extension's own non-GET requests", () => {
    const twitch = rule(9101);
    const kick = rule(9102);
    expect(twitch.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://www.twitch.tv" }]);
    expect(twitch.condition.requestDomains).toEqual(["twitch.tv", "ttvnw.net", "twitchcdn.net", "live-video.net"]);
    expect(kick.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://kick.com" }]);
    expect(kick.condition.requestDomains).toEqual(["kick.com"]);
    for (const candidate of [twitch, kick]) {
      // Granted GET/HEAD carry no Origin; the HLS watch keeps its plain requests.
      expect(candidate.condition.excludedRequestMethods).toEqual(["get", "head"]);
      expect(candidate.condition.resourceTypes).toBeUndefined();
    }
  });

  // A handshake is a GET, so the socket rules cannot exclude GET (#792).
  it("sets each platform's site origin on the extension's own sockets", () => {
    const twitch = rule(9103);
    const kick = rule(9104);
    expect(twitch.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://www.twitch.tv" }]);
    expect(twitch.condition.requestDomains).toEqual(["twitch.tv"]);
    expect(kick.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://kick.com" }]);
    expect(kick.condition.requestDomains).toEqual(["kick.com", "pusher.com"]);
    for (const candidate of [twitch, kick]) {
      expect(candidate.condition.resourceTypes).toEqual(["websocket"]);
      expect(candidate.condition.excludedRequestMethods).toBeUndefined();
    }
  });

  it("names the origin a platform socket presents", () => {
    expect(platformSocketOrigin("wss://hermes.twitch.tv/v1?clientId=abc")).toBe("https://www.twitch.tv");
    expect(platformSocketOrigin("wss://irc-ws.chat.twitch.tv/")).toBe("https://www.twitch.tv");
    expect(platformSocketOrigin("wss://websockets.kick.com/viewer/v1/connect?token=t")).toBe("https://kick.com");
    expect(platformSocketOrigin("wss://ws-us2.pusher.com/app/key?protocol=7")).toBe("https://kick.com");
    expect(platformSocketOrigin("wss://backend.p-n6412w7dsu.exmggames.com/handler")).toBeUndefined();
    expect(platformSocketOrigin("wss://twitch.tv.evil.example/")).toBeUndefined();
    expect(platformSocketOrigin("wss://eviltwitch.tv/")).toBeUndefined();
    expect(platformSocketOrigin("https://gql.twitch.tv/gql")).toBeUndefined();
    expect(platformSocketOrigin("not a url")).toBeUndefined();
  });

  it("replaces its own rules on every start", async () => {
    const updateDynamicRules = vi.fn(async () => {});

    await expect(installPlatformOriginRules({ updateDynamicRules }, "abcdefghijklmnop")).resolves.toBe(true);
    await installPlatformOriginRules({ updateDynamicRules }, "abcdefghijklmnop");

    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules).toHaveBeenLastCalledWith({
      removeRuleIds: [...PLATFORM_ORIGIN_RULE_IDS],
      addRules: platformOriginRules("abcdefghijklmnop"),
    });
  });

  it("reports no rules where the browser has no declarativeNetRequest", async () => {
    await expect(installPlatformOriginRules(undefined, "abcdefghijklmnop")).resolves.toBe(false);
  });
});
