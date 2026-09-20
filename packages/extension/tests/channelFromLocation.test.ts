import { describe, expect, it } from "vitest";
import { channelFromLocation } from "../src/core/inPagePanel";

describe("channelFromLocation on Twitch", () => {
  it("reads the channel from a channel page and its own subpages", () => {
    expect(channelFromLocation("twitch", "https://www.twitch.tv/summit1g")).toBe("summit1g");
    expect(channelFromLocation("twitch", "https://www.twitch.tv/Summit1G/")).toBe("summit1g");
    for (const subpath of ["about", "schedule", "videos", "clips"]) {
      expect(channelFromLocation("twitch", `https://www.twitch.tv/summit1g/${subpath}`), subpath).toBe("summit1g");
    }
    expect(channelFromLocation("twitch", "https://www.twitch.tv/summit1g/clip/SomeClipSlug")).toBe("summit1g");
  });

  it("refuses the site's own pages", () => {
    const reserved = [
      "https://www.twitch.tv/",
      "https://www.twitch.tv/directory/game/Rust",
      "https://www.twitch.tv/videos/123456",
      "https://www.twitch.tv/drops/inventory",
      "https://www.twitch.tv/settings/profile",
      "https://www.twitch.tv/subscriptions",
      "https://www.twitch.tv/wallet",
      "https://www.twitch.tv/u/summit1g",
      "https://www.twitch.tv/popout/summit1g/chat",
      "https://www.twitch.tv/moderator/summit1g",
    ];
    for (const url of reserved) expect(channelFromLocation("twitch", url), url).toBeUndefined();
  });

  it("refuses a subpage that is not the channel's own", () => {
    expect(channelFromLocation("twitch", "https://www.twitch.tv/summit1g/squad/extra")).toBeUndefined();
  });
});

describe("channelFromLocation on Kick", () => {
  it("reads the channel from a channel page and its own subpages", () => {
    expect(channelFromLocation("kick", "https://kick.com/trainwreckstv")).toBe("trainwreckstv");
    for (const subpath of ["videos", "clips", "about"]) {
      expect(channelFromLocation("kick", `https://kick.com/trainwreckstv/${subpath}`), subpath).toBe("trainwreckstv");
    }
  });

  it("refuses the site's own pages", () => {
    const reserved = [
      "https://kick.com/",
      "https://kick.com/browse",
      "https://kick.com/categories/slots",
      "https://kick.com/following",
      "https://kick.com/dashboard/settings",
      "https://kick.com/search?query=rust",
    ];
    for (const url of reserved) expect(channelFromLocation("kick", url), url).toBeUndefined();
  });
});

describe("channelFromLocation input handling", () => {
  it("returns nothing for a URL it cannot parse", () => {
    expect(channelFromLocation("twitch", "not a url")).toBeUndefined();
  });

  it("ignores query strings and fragments", () => {
    expect(channelFromLocation("twitch", "https://www.twitch.tv/summit1g?tt_content=hero#chat")).toBe("summit1g");
  });
});
