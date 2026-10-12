import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_ORIGIN_RULE_IDS,
  installPlatformOriginRules,
  platformOriginRules,
} from "../src/core/platformRequestOrigin";

describe("platform request origin rules", () => {
  it("sets each platform's site origin on the extension's own non-GET requests", () => {
    const rules = platformOriginRules("abcdefghijklmnop");

    expect(rules.map((rule) => rule.id)).toEqual([...PLATFORM_ORIGIN_RULE_IDS]);
    const [twitch, kick] = rules;
    expect(twitch.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://www.twitch.tv" }]);
    expect(twitch.condition.requestDomains).toEqual(["twitch.tv", "ttvnw.net", "twitchcdn.net", "live-video.net"]);
    expect(kick.action.requestHeaders).toEqual([{ header: "origin", operation: "set", value: "https://kick.com" }]);
    expect(kick.condition.requestDomains).toEqual(["kick.com"]);
    for (const rule of rules) {
      // Only the extension's own requests: a platform page's requests have the
      // platform as initiator and are never touched.
      expect(rule.condition.initiatorDomains).toEqual(["abcdefghijklmnop"]);
      // Granted GET/HEAD carry no Origin; the HLS watch keeps its plain requests.
      expect(rule.condition.excludedRequestMethods).toEqual(["get", "head"]);
    }
  });

  it("replaces its own rules on every start", async () => {
    const updateDynamicRules = vi.fn(async () => {});

    await installPlatformOriginRules({ updateDynamicRules }, "abcdefghijklmnop");
    await installPlatformOriginRules({ updateDynamicRules }, "abcdefghijklmnop");

    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules).toHaveBeenLastCalledWith({
      removeRuleIds: [...PLATFORM_ORIGIN_RULE_IDS],
      addRules: platformOriginRules("abcdefghijklmnop"),
    });
  });

  it("does nothing where the browser has no declarativeNetRequest", async () => {
    await expect(installPlatformOriginRules(undefined, "abcdefghijklmnop")).resolves.toBeUndefined();
  });
});
