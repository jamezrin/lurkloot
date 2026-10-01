import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KASADA_COOKIE_ORIGIN } from "../src/core/cliCredentialExport";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../wxt.config.ts"), "utf8");

describe("extension host permissions", () => {
  it("requires only Twitch and Kick, keeping the Kasada cookie host optional", () => {
    const required = source.match(/(?<!optional_)host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";

    expect(required).toContain('"https://*.twitch.tv/*"');
    expect(required).toContain('"https://*.kick.com/*"');
    expect(required).not.toContain("twitchcdn");
    for (const origin of [
      "https://www.twitch.tv/*",
      "https://gql.twitch.tv/*",
      "https://kick.com/*",
      "https://web.kick.com/*",
      "https://websockets.kick.com/*",
      "https://assets.twitch.tv/*",
      "https://spade.twitch.tv/*",
      "https://beacon.twitch.tv/*",
    ]) {
      expect(required).not.toContain(`"${origin}"`);
    }
    const optional = source.match(/optional_host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    expect(optional.trim()).toBe("KASADA_COOKIE_ORIGIN");
    expect(source).not.toContain("optional_permissions:");
  });

  it("names only the exact Kasada cookie host", () => {
    expect(KASADA_COOKIE_ORIGIN).toBe("https://k.twitchcdn.net/*");
  });
});
