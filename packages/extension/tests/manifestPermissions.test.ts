import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../wxt.config.ts"), "utf8");

describe("extension host permissions", () => {
  it("grants only the exact additional Twitch hosts required by Spade", () => {
    expect(source).toContain('"https://assets.twitch.tv/*"');
    expect(source).toContain('"https://spade.twitch.tv/*"');
    expect(source).toContain('"https://beacon.twitch.tv/*"');
    expect(source).not.toContain('"https://*.twitch.tv/*"');
  });
});
