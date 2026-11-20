import { describe, expect, it, vi } from "vitest";
import { kickHttpChallenge, kickHttpError } from "@lurkloot/core/transport";
import type { PageFetchOptions } from "../src/core/browserTabs";
import { KickPageContextFallback } from "../src/core/kickPageDocument";

const IDENTITY = "https://kick.com/api/v1/user";
const CAMPAIGNS = "https://web.kick.com/api/v1/drops/campaigns";

function reuseOnly(fallback: KickPageContextFallback, url: string, error: unknown): boolean {
  return fallback.options(url, error).reusePageContextOrThrow !== undefined;
}

async function challengedPage(fallback: KickPageContextFallback, url: string): Promise<void> {
  await fallback
    .fetch(url, kickHttpChallenge(403), async () => {
      throw kickHttpChallenge(403);
    })
    .catch(() => undefined);
}

describe("KickPageContextFallback", () => {
  it("takes the normal fallback until the page context itself is challenged", async () => {
    const fallback = new KickPageContextFallback();
    const challenge = kickHttpChallenge(403);
    expect(reuseOnly(fallback, IDENTITY, challenge)).toBe(false);
    expect(fallback.options(IDENTITY, challenge)).toMatchObject({
      retainPageContext: { platform: "kick" },
      openReason: "background_rejected",
      challengeError: kickHttpChallenge,
    });

    await challengedPage(fallback, IDENTITY);

    expect(reuseOnly(fallback, IDENTITY, challenge)).toBe(true);
    expect(fallback.options(IDENTITY, challenge).reusePageContextOrThrow).toBe(challenge);
    // Only an HTTP challenge from the service worker is limited to reuse.
    expect(reuseOnly(fallback, IDENTITY, kickHttpError(500, ""))).toBe(false);
    // The latch belongs to the challenged host.
    expect(reuseOnly(fallback, CAMPAIGNS, challenge)).toBe(false);
  });

  it("keeps the latch through other page failures and clears it on a success for that host", async () => {
    const fallback = new KickPageContextFallback();
    const challenge = kickHttpChallenge(403);
    await challengedPage(fallback, IDENTITY);
    await challengedPage(fallback, CAMPAIGNS);

    await fallback
      .fetch(IDENTITY, challenge, async () => {
        throw new Error("tab closed");
      })
      .catch(() => undefined);
    expect(reuseOnly(fallback, IDENTITY, challenge)).toBe(true);

    const fetchInPage = vi.fn(async (_options: PageFetchOptions) => ({ id: 42 }));
    await expect(fallback.fetch(IDENTITY, challenge, fetchInPage)).resolves.toEqual({ id: 42 });
    expect(fetchInPage.mock.calls[0]?.[0].reusePageContextOrThrow).toBe(challenge);
    expect(reuseOnly(fallback, IDENTITY, challenge)).toBe(false);
    expect(reuseOnly(fallback, CAMPAIGNS, challenge)).toBe(true);

    fallback.recordBackgroundSuccess("web.kick.com");
    expect(reuseOnly(fallback, CAMPAIGNS, challenge)).toBe(false);
  });
});
