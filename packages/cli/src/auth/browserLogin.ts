import { chromium } from "playwright";
import { integrityFromHeaders } from "@stream-autopilot/core/twitchIntegrity";
import { AuthStore, type PlatformCredentials } from "../authStore";

export interface BrowserLoginOptions {
  authDir: string;
  twitch: boolean;
  kick: boolean;
  timeoutMs?: number;
}

const TWITCH_LOGIN = "https://www.twitch.tv/login";
const KICK_HOME = "https://kick.com/";
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Browser-assisted login: opens a real (headed) Chromium on the persistent profile
// the browser transport reuses, waits for the user to sign in, and harvests the
// resulting cookies (+ a Twitch integrity token captured from page traffic) into
// the auth store. The persistent profile means the browser transport then runs
// already logged in.
export async function runBrowserLogin(options: BrowserLoginOptions): Promise<void> {
  const store = new AuthStore(options.authDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const context = await chromium.launchPersistentContext(store.browserProfileDir, { headless: false });

  context.on("request", (request) => {
    if (!request.url().startsWith("https://gql.twitch.tv/")) return;
    void request
      .allHeaders()
      .then(async (headers) => {
        const integrity = integrityFromHeaders(Object.entries(headers).map(([name, value]) => ({ name, value })));
        if (integrity) await store.saveIntegrity(integrity);
      })
      .catch(() => undefined);
  });

  if (options.twitch) await context.newPage().then((page) => page.goto(TWITCH_LOGIN).catch(() => undefined));
  if (options.kick) await context.newPage().then((page) => page.goto(KICK_HOME).catch(() => undefined));

  console.log("\nA browser window opened. Sign in to:");
  if (options.twitch) console.log("  • Twitch (twitch.tv)");
  if (options.kick) console.log("  • Kick (kick.com)");
  console.log("\nWaiting for login… (this window closes automatically once detected)\n");

  const deadline = Date.now() + timeoutMs;
  let captured: PlatformCredentials = await store.loadCredentials();
  const now = () => new Date().toISOString();

  try {
    while (Date.now() < deadline) {
      const twitchCookies = options.twitch ? await context.cookies("https://www.twitch.tv") : [];
      const kickCookies = options.kick ? await context.cookies("https://kick.com") : [];

      const authToken = twitchCookies.find((cookie) => cookie.name === "auth-token")?.value;
      const deviceId = twitchCookies.find((cookie) => cookie.name === "unique_id")?.value;
      const sessionToken = kickCookies.find((cookie) => cookie.name === "session_token")?.value;

      if (options.twitch && authToken && !captured.twitch) {
        captured = { ...captured, twitch: { authToken, deviceId, source: "login", obtainedAt: now() } };
        await store.saveCredentials(captured);
        console.log("✔ Captured Twitch session.");
      }
      if (options.kick && sessionToken && !captured.kick) {
        captured = { ...captured, kick: { sessionToken, source: "login", obtainedAt: now() } };
        await store.saveCredentials(captured);
        console.log("✔ Captured Kick session.");
      }

      const twitchDone = !options.twitch || captured.twitch != null;
      const kickDone = !options.kick || captured.kick != null;
      if (twitchDone && kickDone) {
        console.log(`\n✔ Login complete. Credentials saved to ${options.authDir}.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("Login timed out before all requested sessions were captured.");
  } finally {
    await context.close().catch(() => undefined);
  }
}
