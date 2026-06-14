import { chromium, type BrowserContext } from "playwright";
import initCycleTLS from "cycletls";
import type { PageFetcher } from "@stream-autopilot/core/adapter";
import { fetchTwitchInBackgroundWith, setTwitchIntegrity, type CookieApi } from "@stream-autopilot/core/tabs";
import { integrityFromHeaders } from "@stream-autopilot/core/twitchIntegrity";
import { KickAdapter } from "@stream-autopilot/core/kick";
import { TwitchAdapter } from "@stream-autopilot/core/twitch";
import { AuthStore, type PlatformCredentials } from "../authStore";
import { tablessWatchPort, type TransportHandle } from "./common";
import { createCycleKickFetcher, createCycleWebSocketFactory } from "./impersonate";

const TWITCH_INTEGRITY_PAGE = "https://www.twitch.tv/drops/inventory";

// Playwright-backed transport. Its unique value over `impersonate` is capturing
// Twitch's page-minted Client-Integrity token (Kasada proof-of-work, impossible
// headless) so drop claims succeed, plus supplying a logged-in session from the
// persistent browser profile. Kick reuses the proven cycletls path (lighter and
// already WAF-clear) rather than driving it through the page.
export async function createBrowserTransport(credentials: PlatformCredentials, authDir: string): Promise<TransportHandle> {
  const store = new AuthStore(authDir);
  const cycleTLS = await initCycleTLS();

  const context = await chromium.launchPersistentContext(store.browserProfileDir, {
    headless: process.env.SA_HEADFUL !== "1",
  });

  // Continuously capture the Client-Integrity token from the live twitch.tv page's
  // own GQL traffic (mirrors the extension's webRequest listener) and persist it.
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

  // Nudge the SPA into minting an integrity token (best-effort; needs a logged-in
  // profile). Not awaited to completion so transport startup never hangs.
  void context
    .newPage()
    .then((page) => page.goto(TWITCH_INTEGRITY_PAGE, { waitUntil: "domcontentloaded", timeout: 20_000 }).then(() => undefined))
    .catch(() => undefined);

  // Twitch fetcher: plain server-side fetch (no WAF) with cookies read live from
  // the browser profile, plus the captured integrity (held in core's store).
  const twitchFetcher: PageFetcher = {
    fetchJson: (url, init) => fetchTwitchInBackgroundWith(contextCookieApi(context), url, init),
  };

  const kickFetcher = createCycleKickFetcher(cycleTLS, credentials);
  const kickWebSocket = createCycleWebSocketFactory(cycleTLS);

  return {
    adapters: {
      twitch: new TwitchAdapter(twitchFetcher, { clientId: credentials.twitch?.clientId, watchTabs: tablessWatchPort }),
      kick: new KickAdapter(kickFetcher, { watchTabs: tablessWatchPort, createWebSocket: kickWebSocket }),
    },
    dispose: async () => {
      await context.close().catch(() => undefined);
      await cycleTLS.exit();
    },
  };
}

// Reads Twitch auth cookies straight from the live Playwright profile so a session
// established by `login` (no manual token paste) is used automatically.
function contextCookieApi(context: BrowserContext): CookieApi {
  return {
    cookies: {
      get: async ({ url, name }) => {
        const cookies = await context.cookies(url);
        const match = cookies.find((cookie) => cookie.name === name);
        return match ? { value: match.value } : undefined;
      },
    },
  };
}
