// Throwaway live-inspection harness for the Kick drop-farming path.
//
// Why this exists: the Kick adapter was built against a Python reference
// (references/kickautodrops) and has never been exercised against live Kick
// infra because there are no active campaigns yet. This script logs into Kick
// with a persistent profile, dumps the real response shapes of every endpoint
// the extension calls, and drives the viewer WebSocket end-to-end so we can
// confirm the tab-less protocol before the June 11 campaign launch.
//
// Usage:
//   node scripts/kick-inspect.mjs --from-chrome        (reuse your real Chrome login — recommended)
//   node scripts/kick-inspect.mjs --from-chrome="Profile 1"  (a non-default Chrome profile)
//   node scripts/kick-inspect.mjs                      (fresh profile; log in once, persists)
//   node scripts/kick-inspect.mjs --channel=xqc        (drive a specific channel)
//   node scripts/kick-inspect.mjs --headless           (after a login already exists)
//
// --from-chrome copies the cookie DB + Local State of your real Chrome profile
// into .tmp/kick-profile-chrome and launches real google-chrome-stable against
// it, so no re-login is needed and your real profile is never opened. Without
// it, the first run is headed: log into Kick, press Enter, and the login
// persists in .tmp/kick-profile.
//
// Raw responses are written to .tmp/kick-samples/ (git-ignored) for the parser
// hardening work. NOTHING here is shipped — see kickWatch.ts / kick.ts for the
// production code this mirrors.

import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";

// Mirrors KICK_CLIENT_TOKEN in src/platforms/kick/watch.ts:10 — confirm it still works.
const KICK_CLIENT_TOKEN = "e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823";
const PROFILE_DIR = resolve(".tmp/kick-profile");
const SEEDED_DIR = resolve(".tmp/kick-profile-chrome");
const SAMPLES_DIR = resolve(".tmp/kick-samples");
const CHROME_CONFIG = join(homedir(), ".config/google-chrome");

const args = new Set(process.argv.slice(2));
const headless = args.has("--headless");
const channelArg = [...args].find((a) => a.startsWith("--channel="))?.slice("--channel=".length);
// Capture-claim mode: open the Drops page, then record the exact request Kick's
// "Pedir"/Claim button fires (URL, method, headers, body, response) so the
// extension's claimReward can be aligned to ground truth. Use with --from-chrome.
const captureClaim = args.has("--capture-claim");
// Category-search discovery mode: probe candidate endpoints for a category search
// and passively record whatever request Kick's own search box fires, so the
// extension's searchCategories can target the real endpoint + shape.
const inspectCategories = args.has("--categories");
const categoryQuery = [...args].find((a) => a.startsWith("--query="))?.slice("--query=".length) ?? "rust";
// Reuse the real Chrome login instead of logging in fresh. Copies the cookie DB
// + Local State of the named profile (default "Default") into a throwaway
// user-data-dir and launches the REAL google-chrome-stable against it. Real
// Chrome is required so the GNOME-keyring "Chrome Safe Storage" key decrypts the
// cookies; a non-default dir sidesteps Chrome 136+'s default-profile automation
// block. The real profile is never opened, so Chrome can stay running.
const fromChromeArg = [...args].find((a) => a === "--from-chrome" || a.startsWith("--from-chrome="));
const fromChrome = fromChromeArg !== undefined;
const sourceProfile = fromChromeArg?.includes("=") ? fromChromeArg.split("=")[1] : "Default";

const findings = [];
function note(label, ok, detail) {
  findings.push({ label, ok, detail });
  const mark = ok === true ? "✓" : ok === false ? "✗" : "•";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function save(name, value) {
  const path = resolve(SAMPLES_DIR, name);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

// Runs fetch() inside the kick.com page so requests carry the logged-in session
// + Cloudflare context — exactly how the extension's pageFetchJson works
// (src/core/tabs.ts:715-739).
async function pageFetch(page, url, init) {
  return page.evaluate(
    async ({ url, init }) => {
      const headers = new Headers(init?.headers ?? {});
      // The extension injects the bearer from the session_token cookie for
      // web.kick.com / websockets.kick.com; reproduce that here.
      if ((url.includes("web.kick.com") || url.includes("websockets.kick.com")) && !headers.has("authorization")) {
        const token = document.cookie
          .split(";")
          .map((p) => p.trim())
          .find((p) => p.startsWith("session_token="))
          ?.slice("session_token=".length);
        if (token) headers.set("authorization", `Bearer ${decodeURIComponent(token)}`);
      }
      const res = await fetch(url, { ...init, headers, credentials: init?.credentials ?? "include" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, ok: res.ok, contentType: res.headers.get("content-type"), json, text: json ? undefined : text.slice(0, 2000) };
    },
    { url, init },
  );
}

// Captures an endpoint via a real in-page fetch() — Chrome's own network stack
// from the kick.com origin, exactly what the extension's pageFetchJson does.
// This is the only path that carries Chrome's TLS fingerprint, so it is the one
// with a chance of passing Kick's WAF (Playwright's request API uses its own
// fingerprint and gets a 403). web.kick.com must allow CORS from kick.com for
// the app to work, so a non-blocked response comes back as JSON here too.
async function captureViaPage(page, name, url, init) {
  try {
    const res = await pageFetch(page, url, init);
    await save(`${name}.json`, res.json ?? res.text ?? "");
    const blocked = typeof res.json?.error === "string" && /security policy|blocked/i.test(res.json.error);
    note(name, res.ok && Boolean(res.json) && !blocked, `HTTP ${res.status}${blocked ? " (WAF block)" : res.json ? " (json captured)" : " (non-json)"}`);
    return res;
  } catch (error) {
    note(name, false, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

// Drives wss://websockets.kick.com/viewer/v1/connect from the PAGE origin
// (kick.com), sending the same handshake/ping/user_event cadence as KickWatcher.
// Captures every server frame for ~75s so a 60s watch event is exercised.
async function inspectViewerSocket(page, token, channelId, livestreamId) {
  return page.evaluate(
    async ({ token, channelId, livestreamId }) => {
      return await new Promise((resolveWs) => {
        const log = [];
        const result = { opened: false, frames: log, error: undefined, closeCode: undefined };
        let counter = 0;
        let watchSentAt = 0;
        let timer;
        const ws = new WebSocket(`wss://websockets.kick.com/viewer/v1/connect?token=${encodeURIComponent(token)}`);
        const send = (obj) => {
          try {
            ws.send(JSON.stringify(obj));
          } catch (e) {
            log.push({ dir: "send-error", error: String(e) });
          }
        };
        const sendWatch = () => {
          send({ type: "user_event", data: { message: { name: "tracking.user.watch.livestream", channel_id: channelId, livestream_id: livestreamId } } });
          watchSentAt = Date.now();
          log.push({ dir: "send", type: "watch" });
        };
        const finish = () => {
          clearInterval(timer);
          try {
            ws.close();
          } catch {}
          resolveWs(result);
        };
        ws.addEventListener("open", () => {
          result.opened = true;
          send({ type: "channel_handshake", data: { message: { channelId } } });
          sendWatch();
          timer = setInterval(() => {
            counter += 1;
            if (counter % 2 === 0) send({ type: "ping" });
            else send({ type: "channel_handshake", data: { message: { channelId } } });
            if (Date.now() - watchSentAt >= 60000) sendWatch();
          }, 13000);
        });
        ws.addEventListener("message", (ev) => log.push({ dir: "recv", data: String(ev.data).slice(0, 500) }));
        ws.addEventListener("error", () => {
          result.error = "WebSocket error event";
          finish();
        });
        ws.addEventListener("close", (ev) => {
          result.closeCode = ev.code;
          result.closeReason = ev.reason;
          finish();
        });
        // Run long enough to send the priming watch event AND the 60s recurring one.
        setTimeout(finish, 75000);
      });
    },
    { token, channelId, livestreamId },
  );
}

// Copies the minimum needed to reuse a real Chrome login: the cookie DB and
// Local State (the rest of the 3GB profile is irrelevant here). Returns false if
// the source files are missing so the caller can fall back to a fresh login.
async function seedFromChrome() {
  const srcCookies = join(CHROME_CONFIG, sourceProfile, "Cookies");
  const srcLocalState = join(CHROME_CONFIG, "Local State");
  if (!existsSync(srcCookies)) {
    note(`Seed from Chrome "${sourceProfile}"`, false, `${srcCookies} not found — pass --from-chrome="Profile 1" etc.`);
    return false;
  }
  await mkdir(join(SEEDED_DIR, "Default"), { recursive: true });
  await copyFile(srcCookies, join(SEEDED_DIR, "Default", "Cookies"));
  for (const sidecar of ["Cookies-journal", "Cookies-wal"]) {
    const p = join(CHROME_CONFIG, sourceProfile, sidecar);
    if (existsSync(p)) await copyFile(p, join(SEEDED_DIR, "Default", sidecar));
  }
  if (existsSync(srcLocalState)) await copyFile(srcLocalState, join(SEEDED_DIR, "Local State"));
  note(`Seed from Chrome "${sourceProfile}"`, true, "copied Cookies + Local State");
  return true;
}

async function main() {
  await mkdir(SAMPLES_DIR, { recursive: true });

  // Decide which profile to drive: a seeded copy of the real Chrome login, or a
  // standalone persistent profile the user logs into once.
  let userDataDir = PROFILE_DIR;
  const launchOptions = { headless, viewport: { width: 1280, height: 800 } };
  if (fromChrome && (await seedFromChrome())) {
    userDataDir = SEEDED_DIR;
    // Real Chrome is mandatory: only it holds the keyring entry that decrypts the
    // copied cookies (Playwright's bundled Chromium uses a different keyring key).
    launchOptions.channel = "chrome";
    // --password-store: force GNOME libsecret or Chrome can't decrypt the copied
    //   cookies. The rest strip the automation signals (navigator.webdriver,
    //   --enable-automation) that Kick's bot-management WAF blocks on.
    launchOptions.args = ["--password-store=gnome-libsecret", "--disable-blink-features=AutomationControlled"];
    launchOptions.ignoreDefaultArgs = ["--enable-automation"];
  }
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto("https://kick.com/", { waitUntil: "domcontentloaded" });
    note("Landed on kick.com", /kick\.com/.test(page.url()), `url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // A present-but-short value means the cookie was copied but the keyring
    // failed to decrypt it (would 401 every API call), so check the value too.
    const sessionCookie = async () => (await context.cookies("https://kick.com")).find((c) => c.name === "session_token");
    const hasSession = async () => {
      const c = await sessionCookie();
      return Boolean(c && c.value && c.value.length > 20);
    };

    if (!(await hasSession())) {
      if (fromChrome) {
        const c = await sessionCookie();
        note(
          "Kick login (seeded from Chrome)",
          false,
          c ? "cookie present but did not decrypt — is the GNOME keyring unlocked? Try a fresh login (omit --from-chrome)" : `no session_token in profile "${sourceProfile}" — log into Kick there, or pass --from-chrome="<other profile>"`,
        );
      } else if (headless) {
        note("Kick login", false, "No session_token cookie. Run once headed (omit --headless) and log in.");
      } else {
        const rl = createInterface({ input: stdin, output: stdout });
        console.log("\n>> Log into Kick in the opened window, then press Enter here...");
        await rl.question("");
        rl.close();
      }
    }
    note("Kick login", await hasSession(), (await hasSession()) ? "session_token present and decrypted" : "no usable session_token");

    // Category-search discovery: probe candidate REST endpoints (in-page fetch),
    // then passively capture the request Kick's own search box fires.
    if (inspectCategories) {
      const q = encodeURIComponent(categoryQuery);
      const candidates = [
        ["search-v1", `https://kick.com/api/v1/search?searched_word=${q}`],
        ["search-legacy", `https://kick.com/api/search?searched_word=${q}`],
        ["search-type-cat", `https://kick.com/api/v1/search?searched_word=${q}&type=categories`],
        ["categories-search", `https://kick.com/api/v1/categories?searched_word=${q}`],
        ["categories-query", `https://kick.com/api/v1/categories?query=${q}`],
        ["subcategories-search", `https://kick.com/api/v1/subcategories?searched_word=${q}`],
        ["web-categories", `https://web.kick.com/api/v1/categories?search=${q}`],
        ["categories-page1", `https://kick.com/api/v1/categories?page=1`],
      ];
      for (const [name, url] of candidates) {
        await captureViaPage(page, `cat-${name}`, url);
      }

      // Passive network capture: whatever the site itself calls when searching.
      const seen = [];
      context.on("request", (req) => {
        if (/search|categor/i.test(req.url())) seen.push(`${req.method()} ${req.url()}`);
      });
      await page.goto("https://kick.com/browse", { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(2500);
      try {
        await page.goto("https://kick.com/", { waitUntil: "domcontentloaded" });
        const box = page.locator('input[type="search"], input[placeholder*="Search" i], input[name*="search" i]').first();
        await box.fill(categoryQuery, { timeout: 5000 });
        await page.waitForTimeout(3500);
      } catch (error) {
        note("Search box typing", undefined, error instanceof Error ? error.message : String(error));
      }
      await save("category-search-requests.json", seen);
      note("Site search/category requests observed", seen.length > 0, `${seen.length} → category-search-requests.json`);
      return;
    }

    // Capture-claim mode: record the real claim request the Drops "Pedir" button
    // fires, so we can align the extension's claimReward to it exactly.
    if (captureClaim) {
      const claims = [];
      const isClaim = (url, method) => method === "POST" && /\/drops\/.*claim|\/claim/i.test(url);
      context.on("request", async (req) => {
        if (!isClaim(req.url(), req.method())) return;
        claims.push({ url: req.url(), method: req.method(), headers: req.headers(), body: req.postData() });
      });
      context.on("response", async (res) => {
        const req = res.request();
        if (!isClaim(req.url(), req.method())) return;
        const body = await res.text().catch(() => "<unreadable>");
        const entry = claims.find((c) => c.url === req.url() && c.response === undefined) ?? {};
        entry.response = { status: res.status(), body: body.slice(0, 2000) };
        note("Captured claim", res.ok(), `HTTP ${res.status()} ${req.url()}`);
      });
      const rl = createInterface({ input: stdin, output: stdout });
      console.log("\n>> Open the Drops page in the window, click 'Pedir' on a reward, then press Enter here...");
      await rl.question("");
      rl.close();
      await save("claim-capture.json", claims);
      note("Claim requests captured", claims.length > 0, `${claims.length} request(s) → claim-capture.json`);
      return;
    }

    // All captures run as a real in-page fetch from the kick.com origin (the
    // extension's exact method). A WAF block here is the authoritative signal
    // for the extension too, since it uses the same path.

    // 1. Drop campaigns — shape is the launch-day unknown; capture whatever exists now.
    await captureViaPage(page, "drops-campaigns", "https://web.kick.com/api/v1/drops/campaigns");
    // 2. Drop progress — needs X-Client-Token or Kick's WAF returns "Request
    //    blocked by security policy." (matches the extension's readProgress).
    await captureViaPage(page, "drops-progress", "https://web.kick.com/api/v1/drops/progress", {
      headers: { "X-Client-Token": KICK_CLIENT_TOKEN },
    });
    // 3. Livestreams (candidate discovery). category_id omitted to just see the shape.
    const live = await captureViaPage(page, "livestreams", "https://web.kick.com/api/v1/livestreams?limit=25&sort=viewer_count_desc");

    // Pick a channel to drive the viewer socket against.
    let channel = channelArg;
    if (!channel) {
      const streams = Array.isArray(live?.json?.data) ? live.json.data : live?.json?.data?.livestreams ?? [];
      channel = streams[0]?.channel?.slug ?? streams[0]?.channel?.username ?? streams[0]?.slug;
    }
    if (!channel) {
      note("Channel selection", false, "Could not auto-pick a live channel; pass --channel=<slug>");
      return;
    }
    note("Channel selection", true, channel);

    // 4. v2 channel endpoint — known Cloudflare/drift risk; confirm livestream{ id, is_live, categories[] }.
    const ch = await captureViaPage(page, "channel-v2", `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`);
    const channelId = ch?.json?.id;
    const livestreamId = ch?.json?.livestream?.id;
    const isLive = Boolean(ch?.json?.livestream?.is_live ?? ch?.json?.livestream);
    note("Channel is live", isLive, `channelId=${channelId ?? "?"} livestreamId=${livestreamId ?? "?"}`);

    // 5. Viewer token exchange — confirms the hardcoded X-Client-Token still works.
    const tokenRes = await captureViaPage(page, "viewer-token", "https://websockets.kick.com/viewer/v1/token", {
      headers: { "X-Client-Token": KICK_CLIENT_TOKEN },
    });
    const token = tokenRes?.json?.data?.token;

    // 6. Viewer WebSocket from the PAGE origin (kick.com). NOTE: this proves the
    //    protocol, not the extension's service-worker Origin — that is what the
    //    in-extension A1 test covers. A page-origin success + SW failure is the
    //    signal to build the page-context relay (Phase C).
    if (token && channelId && livestreamId && isLive) {
      // Return to a kick.com page (the captures navigated to API URLs); the WS
      // is opened from this page's origin.
      await page.goto(`https://kick.com/${encodeURIComponent(channel)}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      console.log("\n>> Driving the viewer WebSocket for ~75s (watch kick.com viewer count)...");
      const ws = await inspectViewerSocket(page, token, channelId, livestreamId);
      await save("viewer-socket.json", ws);
      note("Viewer WebSocket (page origin)", ws.opened && !ws.error, ws.error ? ws.error : `frames=${ws.frames.length} close=${ws.closeCode ?? "n/a"}`);
    } else {
      note("Viewer WebSocket (page origin)", undefined, "Skipped: need token + live channelId + livestreamId");
    }
  } finally {
    console.log(`\nSamples written to ${SAMPLES_DIR}`);
    console.log("\n=== FINDINGS ===");
    for (const f of findings) {
      const mark = f.ok === true ? "PASS" : f.ok === false ? "FAIL" : "SKIP";
      console.log(`[${mark}] ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
