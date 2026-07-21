import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../wxt.config.ts"), "utf8");

describe("extension host permissions", () => {
  it("keeps established hosts required and platform wildcards optional", () => {
    const required = source.match(/host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    const optional = source.match(/const OPTIONAL_PLATFORM_HOSTS = \[([\s\S]*?)\]/)?.[1] ?? "";

    for (const origin of [
      "https://www.twitch.tv/*",
      "https://gql.twitch.tv/*",
      "https://kick.com/*",
      "https://web.kick.com/*",
      "https://websockets.kick.com/*",
    ]) {
      expect(required).toContain(`"${origin}"`);
    }
    for (const origin of [
      "https://assets.twitch.tv/*",
      "https://spade.twitch.tv/*",
      "https://beacon.twitch.tv/*",
      "https://*.twitch.tv/*",
      "https://*.kick.com/*",
    ]) {
      expect(required).not.toContain(`"${origin}"`);
    }
    expect(optional).toContain('"https://*.twitch.tv/*"');
    expect(optional).toContain('"https://*.kick.com/*"');
    expect(source).toContain("optional_host_permissions: OPTIONAL_PLATFORM_HOSTS");
    expect(source).toContain("optional_permissions: OPTIONAL_PLATFORM_HOSTS");
  });
});
