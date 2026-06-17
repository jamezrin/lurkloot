import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { saveCredentials, type PlatformCredentials } from "../authStore";
import type { Logger } from "../logger";

export interface BrowserLoginOptions {
  twitchOnly?: boolean;
  kickOnly?: boolean;
  // How long to wait for the user to finish signing in, per platform.
  timeoutMs?: number;
}

// Browser-assisted login: opens a headful Chromium (persisted under authDir so
// the session survives restarts), lets the user sign in to Twitch and/or Kick,
// then lifts the session cookies the transports replay (Twitch auth-token /
// unique_id, Kick session_token) into the auth store. Interactive — needs a
// display — so it is verified by hand, not in CI.
export async function browserLogin(authDir: string, options: BrowserLoginOptions, logger: Logger): Promise<void> {
  const doTwitch = !options.kickOnly;
  const doKick = !options.twitchOnly;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const context = await chromium.launchPersistentContext(join(authDir, "browser-profile"), { headless: false });
  try {
    if (doTwitch) {
      logger.info("Sign in to Twitch in the opened window…", "login");
      const page = await context.newPage();
      await page.goto("https://www.twitch.tv/login");
      await waitForCookie(context, "https://www.twitch.tv", "auth-token", timeoutMs, logger, "Twitch");
    }
    if (doKick) {
      logger.info("Sign in to Kick in the opened window…", "login");
      const page = await context.newPage();
      await page.goto("https://kick.com/");
      await waitForCookie(context, "https://kick.com", "session_token", timeoutMs, logger, "Kick");
    }
    const creds = await collectCredentials(context, doTwitch, doKick);
    saveCredentials(authDir, creds);
    logger.info("Saved credentials to the auth store", "login");
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waitForCookie(
  context: BrowserContext,
  url: string,
  name: string,
  timeoutMs: number,
  logger: Logger,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await context.cookies(url);
    if (cookies.some((cookie) => cookie.name === name && cookie.value)) {
      logger.info(`${label} sign-in detected`, "login");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  logger.warn(`Timed out waiting for ${label} sign-in; saving whatever cookies are present`, "login");
}

async function collectCredentials(context: BrowserContext, doTwitch: boolean, doKick: boolean): Promise<PlatformCredentials> {
  const creds: PlatformCredentials = {};
  if (doTwitch) {
    const cookies = await context.cookies("https://www.twitch.tv");
    creds.twitch = {
      authToken: cookies.find((c) => c.name === "auth-token")?.value,
      deviceId: cookies.find((c) => c.name === "unique_id")?.value,
    };
  }
  if (doKick) {
    const cookies = await context.cookies("https://kick.com");
    creds.kick = { sessionToken: cookies.find((c) => c.name === "session_token")?.value };
  }
  return creds;
}
