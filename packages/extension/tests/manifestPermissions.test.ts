import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../wxt.config.ts"), "utf8");

describe("extension host permissions", () => {
  it("requires only the Twitch and Kick wildcard hosts", () => {
    const required = source.match(/host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";

    expect(required).toContain('"https://*.twitch.tv/*"');
    expect(required).toContain('"https://*.kick.com/*"');
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
    expect(source).not.toContain("optional_host_permissions");
    expect(source).not.toContain("optional_permissions");
  });
});
