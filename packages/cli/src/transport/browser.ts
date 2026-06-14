import { chromium, type BrowserContext } from "playwright";
import initCycleTLS, { type CycleTLSClient } from "cycletls";
import type { PageFetcher } from "@stream-autopilot/core/adapter";
import { fetchTwitchInBackgroundWith, hasValidTwitchIntegrity, setTwitchIntegrity, type CookieApi } from "@stream-autopilot/core/tabs";
import { integrityFromHeaders } from "@stream-autopilot/core/twitchIntegrity";
import { KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import { AuthStore, type PlatformCredentials } from "../authStore";
import { disabledFetcher, tablessWatchPort, type EnabledPlatforms, type TransportHandle } from "./common";
import { createCycleKickFetcher, createCycleWebSocketFactory } from "./impersonate";

const TWITCH_INTEGRITY_PAGE = "https://www.twitch.tv/drops/inventory";
const INTEGRITY_WAIT_MS = 15_000;
const INTEGRITY_POLL_MS = 500;
const COOKIE_TTL_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Playwright-backed transport. Its unique value over `impersonate` is capturing
// Twitch's page-minted Client-Integrity token (Kasada proof-of-work, impossible
// headless) so drop claims succeed, plus supplying a logged-in session from the
// persistent browser profile. Kick reuses the cycletls path. Heavy resources are
// only started for the platforms actually enabled.
export async function createBrowserTransport(credentials: PlatformCredentials, authDir: string, enabled: EnabledPlatforms): Promise<TransportHandle> {
  const store = new AuthStore(authDir);

  let context: BrowserContext | undefined;
  let cycleTLS: CycleTLSClient | undefined;

  // Twitch: only a real browser can mint integrity, so launch Chromium just for it.
  const twitch = enabled.twitch
    ? new TwitchAdapter(await twitchBrowserFetcher(), {
        clientId: credentials.twitch?.clientId,
        watchTabs: tablessWatchPort,
        ensureIntegrity: ensureIntegrity,
      })
    : new TwitchAdapter(disabledFetcher("twitch"), { watchTabs: tablessWatchPort });

  // Kick: cycletls (no browser needed), same as the impersonate transport.
  if (enabled.kick) cycleTLS = await initCycleTLS();
  const kick = cycleTLS
    ? new KickAdapter(createCycleKickFetcher(cycleTLS, credentials.kick?.sessionToken), {
        watchTabs: tablessWatchPort,
        createWebSocket: createCycleWebSocketFactory(cycleTLS),
      })
    : new KickAdapter(disabledFetcher("kick"), { watchTabs: tablessWatchPort });

  return {
    adapters: { twitch, kick },
    dispose: async () => {
      await context?.close().catch(() => undefined);
      if (cycleTLS) await cycleTLS.exit();
    },
  };

  // --- Twitch helpers (close over the lazily-created context) ---

  async function twitchBrowserFetcher(): Promise<PageFetcher> {
    context = await chromium.launchPersistentContext(store.browserProfileDir, {
      headless: process.env.SA_HEADFUL !== "1",
    });

    // Continuously capture the Client-Integrity token from the live twitch.tv
    // page's own GQL traffic (mirrors the extension's webRequest listener).
    context.on("request", (request) => {
      if (!request.url().startsWith("https://gql.twitch.tv/")) return;
      void request
        .allHeaders()
        .then(async (headers) => {
          const integrity = integrityFromHeaders(Object.entries(headers).map(([name, value]) => ({ name, value })));
          if (!integrity) return;
          setTwitchIntegrity(integrity, { isNew: true });
          await store.saveIntegrity(integrity);
        })
        .catch(() => undefined);
    });

    // Seed integrity early so a claim soon after startup is ready.
    void ensureIntegrity();

    const cookieApi = cachedContextCookieApi(context);
    return { fetchJson: (url, init) => fetchTwitchInBackgroundWith(cookieApi, url, init) };
  }

  // Actively mint integrity when none is valid: load the inventory page (the SPA
  // issues authenticated GQL that the request listener captures) and wait. Returns
  // whether a valid token is present afterward, so claimReward's retry path works.
  async function ensureIntegrity(): Promise<boolean> {
    if (hasValidTwitchIntegrity()) return true;
    if (!context) return false;
    let page;
    try {
      page = await context.newPage();
      await page.goto(TWITCH_INTEGRITY_PAGE, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      const deadline = Date.now() + INTEGRITY_WAIT_MS;
      while (Date.now() < deadline) {
        if (hasValidTwitchIntegrity()) return true;
        await sleep(INTEGRITY_POLL_MS);
      }
    } catch {
      // Best-effort; a logged-out profile simply never mints a token.
    } finally {
      await page?.close().catch(() => undefined);
    }
    return hasValidTwitchIntegrity();
  }
}

// Reads Twitch auth cookies from the live Playwright profile (so a `login` session
// is used with no token paste), caching the cookie list briefly to avoid two
// cross-process round-trips on every GQL request during farming.
function cachedContextCookieApi(context: BrowserContext): CookieApi {
  const cache = new Map<string, { at: number; values: Record<string, string> }>();
  return {
    cookies: {
      get: async ({ url, name }) => {
        let entry = cache.get(url);
        if (!entry || Date.now() - entry.at > COOKIE_TTL_MS) {
          const list = await context.cookies(url);
          entry = { at: Date.now(), values: Object.fromEntries(list.map((cookie) => [cookie.name, cookie.value])) };
          cache.set(url, entry);
        }
        return name in entry.values ? { value: entry.values[name] } : undefined;
      },
    },
  };
}
