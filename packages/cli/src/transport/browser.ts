import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  fetchTwitchInBackgroundWith,
  hasValidTwitchIntegrity,
  setTwitchIntegrity,
  TWITCH_PAGE_CONTEXT_URL,
} from "@lurkloot/core/tabs";
import { integrityFromHeaders, type TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import type { PreparedWatchTab, WatchTabPort } from "@lurkloot/core/adapter";
import { KickAdapter } from "@lurkloot/core/kick";
import { TwitchAdapter } from "@lurkloot/core/twitch";
import type { PlatformCredentials } from "../authStore";
import { twitchCookieApi } from "./cookieApi";
import { createCycleKickFetcher, createCycleKickWebSocketFactory, initCycle } from "./cycle";
import type { EnabledPlatforms, TransportHandle } from "./common";

export interface BrowserTransportOptions {
  // Headful is occasionally needed for an interactive login; farming runs
  // headless (the Docker image ships the headless shell). SA_HEADFUL=1 forces
  // headful.
  headless?: boolean;
}

// Builds a TwitchIntegrity from a request's header map, if it carries a
// client-integrity token. Exported for unit testing the capture mapping.
export function integrityFromRequestHeaders(headers: Record<string, string>): TwitchIntegrity | undefined {
  return integrityFromHeaders(Object.entries(headers).map(([name, value]) => ({ name, value })));
}

// Playwright transport. Twitch needs a real page only to mint the Client-
// Integrity (Kasada) token that authenticated mutations — drop claims — require
// and that cannot be minted headlessly; we capture it from the live page's
// gql.twitch.tv requests and feed it to the engine, while the actual API calls
// still go over the cookie-backed fetcher (which replays the captured token).
// Kick rides cycletls, same as the impersonate transport.
export async function createBrowserTransport(
  creds: PlatformCredentials,
  authDir: string,
  _enabled: EnabledPlatforms,
  options: BrowserTransportOptions = {},
): Promise<TransportHandle> {
  const headless = options.headless ?? process.env.SA_HEADFUL !== "1";
  const context = await chromium.launchPersistentContext(join(authDir, "browser-profile"), { headless });
  const cycleTLS = await initCycle();

  // The logged-in twitch.tv SPA attaches a fresh Client-Integrity token to its
  // GQL requests; capture it from the live traffic and hand it to the engine so
  // claims carry a valid token (and the matching device/session ids).
  context.on("request", (request) => {
    if (!request.url().includes("gql.twitch.tv")) return;
    const integrity = integrityFromRequestHeaders(request.headers());
    if (integrity) setTwitchIntegrity(integrity, { isNew: true });
  });

  const pages = new Map<number, Page>();
  let nextTabId = 1;

  const watchTabPort: WatchTabPort = {
    async openPinnedMutedTab(channel): Promise<PreparedWatchTab> {
      const page = await context.newPage();
      await page.goto(channel.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      const tabId = nextTabId++;
      pages.set(tabId, page);
      return { tabId, managedByExtension: true };
    },
    async stopWatchTab(session): Promise<void> {
      if (session.tabId == null) return;
      const page = pages.get(session.tabId);
      if (!page) return;
      pages.delete(session.tabId);
      await page.close().catch(() => undefined);
    },
  };

  // Opens the logged-in inventory page so the SPA mints a token the request hook
  // captures, then resolves once a valid one is present (or times out).
  const ensureIntegrity = async (): Promise<boolean> => {
    if (hasValidTwitchIntegrity()) return true;
    const page = await context.newPage();
    try {
      await page.goto(TWITCH_PAGE_CONTEXT_URL, { waitUntil: "domcontentloaded" });
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (hasValidTwitchIntegrity()) return true;
        await page.waitForTimeout(250);
      }
    } catch {
      // A login wall / navigation failure just means no token; the caller falls
      // back to anonymous queries (claims will be skipped).
    } finally {
      await page.close().catch(() => undefined);
    }
    return hasValidTwitchIntegrity();
  };

  return {
    adapters: {
      twitch: new TwitchAdapter(
        { fetchJson: (url, init) => fetchTwitchInBackgroundWith(twitchCookieApi(creds), url, init) },
        ensureIntegrity,
        watchTabPort,
      ),
      kick: new KickAdapter(
        createCycleKickFetcher(cycleTLS, creds),
        watchTabPort,
        createCycleKickWebSocketFactory(cycleTLS, creds),
      ),
    },
    async dispose() {
      await closeContext(context);
      await cycleTLS.exit();
    },
  };
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);
}
