import type { Impit, ImpitOptions } from "impit";
import type { ImpersonatedResponse, ImpersonatingClient } from "./impersonation";

// impit's own Chrome profile: its TLS and HTTP/2 fingerprint, and the
// user agent and client hints that go with it. "chrome" follows the newest
// profile the pinned impit release ships, so a bump of the impit version moves
// the fingerprint with it.
export const IMPIT_BROWSER = "chrome" satisfies ImpitOptions["browser"];

type ImpitModule = { Impit: new (options?: ImpitOptions) => Impit };

/** Loads impit (its native add-on) and builds the one client the CLI shares. */
export async function initImpit(): Promise<Impit> {
  // Imported here, not at the top, so a CLI on another backend never loads the
  // native add-on.
  const loaded = (await import("impit")) as ImpitModule & { default?: ImpitModule };
  const { Impit: ImpitClass } = loaded.default ?? loaded;
  return new ImpitClass({ browser: IMPIT_BROWSER, timeout: null });
}

// impit sends the headers of a page navigation (sec-fetch-mode: navigate,
// upgrade-insecure-requests, an HTML accept) on every request. Every request
// the CLI makes is one a page's script would make, so it is sent as a fetch()
// is: cors mode, an empty destination, and the site relation of the Origin it
// carries. Headers the caller sets win; an empty string drops one of impit's.
function fetchSite(url: string, headers: Record<string, string>): string {
  const from = headerValue(headers, "origin") ?? headerValue(headers, "referer");
  if (!from) return "cross-site";
  try {
    const target = new URL(url);
    const source = new URL(from);
    if (source.origin === target.origin) return "same-origin";
    return siteOf(source.hostname) === siteOf(target.hostname) ? "same-site" : "cross-site";
  } catch {
    return "cross-site";
  }
}

// The registrable domain, approximated as the last two labels: every host the
// CLI talks to (kick.com, twitch.tv, ttvnw.net …) has a one-label suffix.
function siteOf(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

// Client hints have to describe the same browser as the user agent: a
// Windows Chrome user agent beside impit's `sec-ch-ua-platform: "macOS"`, or
// Chrome client hints beside the Twitch Android app's user agent, is a
// browser that does not exist.
export function clientHintsFor(userAgent: string): Record<string, string> {
  const chrome = /\bChrome\/(\d+)/.exec(userAgent);
  if (!chrome || !/Mozilla\//.test(userAgent)) {
    return { "sec-ch-ua": "", "sec-ch-ua-mobile": "", "sec-ch-ua-platform": "" };
  }
  const major = chrome[1];
  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /CrOS/.test(userAgent)
          ? "Chrome OS"
          : /Linux|X11/.test(userAgent)
            ? "Linux"
            : "Unknown";
  return {
    "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    "sec-ch-ua-mobile": /Mobile/.test(userAgent) ? "?1" : "?0",
    "sec-ch-ua-platform": `"${platform}"`,
  };
}

export function impitHeaders(
  url: string,
  headers: Record<string, string>,
  userAgent: string | undefined,
): Record<string, string> {
  const shaped: Record<string, string> = {
    accept: "*/*",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-fetch-site": fetchSite(url, headers),
    "sec-fetch-user": "",
    "upgrade-insecure-requests": "",
    priority: "u=1, i",
    ...(userAgent ? { "user-agent": userAgent, ...clientHintsFor(userAgent) } : {}),
  };
  for (const [key, value] of Object.entries(headers)) {
    delete shaped[key.toLowerCase()];
    shaped[key] = value;
  }
  return shaped;
}

function headerRecord(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) out["set-cookie"] = cookies;
  return out;
}

// The impit backend: impit's Chrome profile (IMPIT_BROWSER), in process. It
// takes the request's abort signal, so a cancelled request ends at once.
export function createImpitClient(impit: Impit): ImpersonatingClient {
  return {
    backend: "impit",
    async request(url, request): Promise<ImpersonatedResponse> {
      const response = await impit.fetch(url, {
        method: request.method.toUpperCase() as "GET" | "POST" | "HEAD",
        headers: impitHeaders(url, request.headers, request.userAgent),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.redirect ? { redirect: request.redirect } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const body = request.method === "head" ? "" : await response.text();
      return {
        status: response.status,
        headers: headerRecord(response.headers),
        body,
        ...(response.url ? { finalUrl: response.url } : {}),
      };
    },
    // impit holds no process or socket the CLI has to release.
    close: async () => {},
  };
}
