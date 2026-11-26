import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Impit } from "impit";
import { KickWafBlockedError } from "@lurkloot/core/transport";
import {
  createImpitClient,
  clientHintsFor,
  IMPIT_BROWSER,
  impitHeaders,
} from "../src/transport/impit";
import { createImpersonateTransport } from "../src/transport/impersonate";
import { impersonationBackendOf, signInBackendOf } from "../src/transport";
import type {
  ImpersonatedRequest,
  ImpersonatedResponse,
  ImpersonatingClient,
} from "../src/transport/impersonation";
import { CHROME_UA } from "../src/transport/common";
import { TRANSPORTS } from "../src/config";

const ENABLED = { twitch: true, kick: true };
const SRC = join(import.meta.dirname, "..", "src");

describe("transport modes", () => {
  it("maps every transport to its impersonating library", () => {
    expect(Object.fromEntries(TRANSPORTS.map((t) => [t, impersonationBackendOf(t)]))).toEqual({
      http: undefined,
      impersonate: "impit",
      impit: "impit",
      cycletls: "cycletls",
    });
  });

  it("signs in to Kick through impit unless cycletls is configured", () => {
    expect(TRANSPORTS.map(signInBackendOf)).toEqual(["impit", "impit", "impit", "cycletls"]);
  });
});

describe("impit profile", () => {
  it("pins the same Chrome version as the user agent Kick requests send", () => {
    const uaMajor = /Chrome\/(\d+)\./.exec(CHROME_UA)?.[1];
    expect(IMPIT_BROWSER).toBe(`chrome${uaMajor}`);
  });
});

describe("impit request headers", () => {
  it("sends a fetch() from the page, not a navigation", () => {
    const headers = impitHeaders(
      "https://web.kick.com/api/v1/drops/progress",
      { Origin: "https://kick.com" },
      undefined,
    );
    expect(headers).toMatchObject({
      accept: "*/*",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "sec-fetch-site": "same-site",
      "sec-fetch-user": "",
      "upgrade-insecure-requests": "",
    });
    expect(headers).not.toHaveProperty("user-agent");
  });

  it("names the site relation from the Origin it carries", () => {
    const site = (url: string, origin?: string) =>
      impitHeaders(url, origin ? { Origin: origin } : {}, undefined)["sec-fetch-site"];
    expect(site("https://kick.com/api/v1/user", "https://kick.com")).toBe("same-origin");
    expect(site("https://video-weaver.ttvnw.net/x", "https://www.twitch.tv")).toBe("cross-site");
    expect(site("https://usher.ttvnw.net/x")).toBe("cross-site");
  });

  it("lets the caller's headers win, whatever their case", () => {
    const headers = impitHeaders("https://kick.com/x", { Accept: "application/json" }, undefined);
    expect(headers.Accept).toBe("application/json");
    expect(headers).not.toHaveProperty("accept");
  });

  it("describes the same browser in client hints as in the user agent", () => {
    expect(clientHintsFor(CHROME_UA)).toEqual({
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });
    // A non-browser user agent (the Twitch Android app) drops impit's Chrome hints.
    expect(
      clientHintsFor("Dalvik/2.1.0 (Linux; U; Android 14) tv.twitch.android.app/26.1.0"),
    ).toEqual({ "sec-ch-ua": "", "sec-ch-ua-mobile": "", "sec-ch-ua-platform": "" });
    expect(impitHeaders("https://kick.com/x", {}, CHROME_UA)["user-agent"]).toBe(CHROME_UA);
  });
});

function fakeImpit(response: {
  status: number;
  body: string;
  headers?: HeadersInit;
  url?: string;
}) {
  const fetch = vi.fn(async (_url: string, _init?: Record<string, unknown>) => ({
    status: response.status,
    headers: new Headers(response.headers),
    url: response.url ?? "",
    text: async () => response.body,
  }));
  return { impit: { fetch } as unknown as Impit, fetch };
}

describe("impit client", () => {
  it("passes the method, body, redirect mode and abort signal to impit", async () => {
    const { impit, fetch } = fakeImpit({
      status: 302,
      body: "moved",
      headers: { location: "https://kick.com/next" },
      url: "https://kick.com/start",
    });
    const caller = new AbortController();
    const response = await createImpitClient(impit).request("https://kick.com/start", {
      method: "post",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
      signal: caller.signal,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://kick.com/start",
      expect.objectContaining({ method: "POST", body: "{}", redirect: "manual" }),
    );
    // impit gets the caller's signal combined with the whole-request deadline.
    const sent = fetch.mock.calls[0]![1]!.signal as AbortSignal;
    expect(sent.aborted).toBe(false);
    caller.abort();
    expect(sent.aborted).toBe(true);
    expect(response).toEqual({
      status: 302,
      headers: { location: "https://kick.com/next" },
      body: "moved",
      finalUrl: "https://kick.com/start",
    });
  });

  it("bounds a request without a caller signal by the whole-request deadline", async () => {
    const { impit, fetch } = fakeImpit({ status: 200, body: "" });
    await createImpitClient(impit).request("https://kick.com/api/tv/link/x", {
      method: "post",
      headers: {},
    });
    const sent = fetch.mock.calls[0]![1]!.signal as AbortSignal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent.aborted).toBe(false);
  });

  it("reads no body for a HEAD", async () => {
    const { impit } = fakeImpit({ status: 200, body: "never read" });
    const response = await createImpitClient(impit).request("https://x.ttvnw.net/s.ts", {
      method: "head",
      headers: {},
    });
    expect(response.body).toBe("");
  });
});

function fakeClient(
  handler: (url: string, request: ImpersonatedRequest) => ImpersonatedResponse,
): ImpersonatingClient & {
  requests: Array<[string, ImpersonatedRequest]>;
  close: ReturnType<typeof vi.fn>;
} {
  const requests: Array<[string, ImpersonatedRequest]> = [];
  return {
    backend: "impit",
    requests,
    request: async (url, request) => {
      requests.push([url, request]);
      return handler(url, request);
    },
    close: vi.fn(async () => {}),
  };
}

describe("impersonate transport over any client", () => {
  it("reaches Kick with Origin, session Bearer and CHROME_UA", async () => {
    const client = fakeClient(() => ({ status: 200, headers: {}, body: '{"data":[]}' }));
    const handle = await createImpersonateTransport(
      { kick: { sessionToken: "sess-token" } },
      ENABLED,
      { createClient: async () => client },
    );
    await expect(handle.adapters.kick.refreshCampaigns()).resolves.toEqual([]);
    const [, request] = client.requests[0]!;
    expect(request.headers.Origin).toBe("https://kick.com");
    expect(request.headers.authorization).toBe("Bearer sess-token");
    expect(request.userAgent).toBe(CHROME_UA);
    await handle.dispose();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("classifies a Cloudflare 403 the same way on every backend", async () => {
    const client = fakeClient(() => ({
      status: 403,
      headers: {},
      body: '{"error":"Request blocked by security policy.","reference":"9e4db7e3"}',
    }));
    const handle = await createImpersonateTransport({ kick: { sessionToken: "t" } }, ENABLED, {
      createClient: async () => client,
    });
    await expect(handle.adapters.kick.refreshCampaigns()).rejects.toBeInstanceOf(
      KickWafBlockedError,
    );
    await handle.dispose();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// impit is imported only when its backend is created, so a CLI on http never
// loads impit's native add-on.
describe("impersonating libraries load lazily", () => {
  it("imports impit as a value only from transport/impit.ts, and only dynamically", () => {
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+"impit"/m;
    const dynamicImport = /import\("impit"\)/;
    const offenders: string[] = [];
    const dynamicIn: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file).split(sep).join("/");
      if (valueImport.test(text)) offenders.push(rel);
      if (dynamicImport.test(text)) dynamicIn.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(dynamicIn).toEqual(["transport/impit.ts"]);
  });

  // CycleTLS is a separate GPL-3.0 program the CLI starts and talks to over a
  // socket (transport/cycleTlsClient.ts). Its npm wrapper is GPL-3.0 code and
  // never runs in the CLI's process: nothing imports it, not even its types.
  it("never imports the cycletls npm package", () => {
    const anyImport = /(from\s+|import\(|require\()\s*"cycletls(\/[^"]*)?"/;
    const offenders = sourceFiles(SRC)
      .filter((file) => anyImport.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
