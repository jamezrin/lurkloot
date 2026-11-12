import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialAvailabilityOf,
  describeCredentialHealth,
  forgetCredentials,
  loadCredentials,
  refreshCredentials,
  saveCredentials,
} from "../src/authStore";
import { createCredentialRefreshingTransport } from "../src/transport";
import { createHttpTransport } from "../src/transport/http";
import { DEFAULT_CLI_SETTINGS, toEngineSettings } from "../src/settings";
import {
  TWITCH_ANDROID_CLIENT_ID,
  TWITCH_SMARTBOX_CLIENT_ID,
  TWITCH_WEB_CLIENT_ID,
} from "../src/twitch";

// A login or logout written while `run`/`serve` runs must reach the requests
// the engine makes, not only the availability check: the transport reloads the
// store before each adapter is built, so the Client-ID and token change together.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lurkloot-refresh-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function gqlCapture() {
  const requests: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ data: { currentUser: { id: "1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return requests;
}

async function probeTwitch(transport: ReturnType<typeof createHttpTransport>) {
  const { adapter } = transport.createAdapter(
    "twitch",
    () => {},
    toEngineSettings(DEFAULT_CLI_SETTINGS),
  );
  return adapter.checkAuthHealth();
}

describe("live credentials", () => {
  it("sends a login made after start with its own Client-ID, and drops it after logout", async () => {
    const requests = gqlCapture();
    const creds = loadCredentials(dir, {});
    const transport = createCredentialRefreshingTransport(
      createHttpTransport(creds, { twitch: true, kick: false }),
      creds,
      dir,
      {},
    );

    saveCredentials(dir, {
      twitch: { authToken: "androidtoken", clientId: TWITCH_ANDROID_CLIENT_ID },
    });
    await probeTwitch(transport);
    const signedIn = requests.at(-1)!;
    expect(signedIn.get("authorization")).toBe("OAuth androidtoken");
    expect(signedIn.get("client-id")).toBe(TWITCH_ANDROID_CLIENT_ID);

    forgetCredentials(dir, "twitch");
    requests.length = 0;
    await probeTwitch(transport);
    for (const headers of requests) expect(headers.get("authorization")).toBeNull();
  });

  it("keeps the last good credentials when the store cannot be read", async () => {
    saveCredentials(dir, { kick: { sessionToken: "kick-good" } });
    const creds = loadCredentials(dir, {});
    await writeFile(join(dir, "credentials.json"), "{not json");
    refreshCredentials(creds, dir, {});
    expect(creds.kick?.sessionToken).toBe("kick-good");
  });

  it("lets an SA_* override win over a refreshed store", () => {
    const creds = loadCredentials(dir, {});
    saveCredentials(dir, { twitch: { authToken: "stored", clientId: TWITCH_SMARTBOX_CLIENT_ID } });
    refreshCredentials(creds, dir, { SA_TWITCH_AUTH_TOKEN: "fromenv" });
    expect(creds.twitch?.authToken).toBe("fromenv");
  });

  it("does not hand the start-up web integrity to a later non-web login", async () => {
    saveCredentials(dir, {
      twitch: { authToken: "webtoken", clientId: TWITCH_WEB_CLIENT_ID, deviceId: "d" },
    });
    const creds = loadCredentials(dir, {});
    const integrity = {
      current: vi.fn(() => undefined),
      ensure: vi.fn(async () => false),
    };
    gqlCapture();
    const transport = createCredentialRefreshingTransport(
      createHttpTransport(creds, { twitch: true, kick: false }, integrity),
      creds,
      dir,
      {},
    );
    forgetCredentials(dir, "twitch");
    saveCredentials(dir, {
      twitch: { authToken: "androidtoken", clientId: TWITCH_ANDROID_CLIENT_ID },
    });
    await probeTwitch(transport);
    expect(integrity.ensure).not.toHaveBeenCalled();
    expect(integrity.current).not.toHaveBeenCalled();
  });

  // The engine's pre-probe gate (index.ts, runCredentialAvailability) reads
  // the store on every probe.
  it("reports availability from the store as it is now", () => {
    const availability = () => credentialAvailabilityOf(describeCredentialHealth(dir, {}).kick);
    expect(availability()).toEqual({ status: "missing" });
    saveCredentials(dir, { kick: { sessionToken: "k" } });
    expect(availability()).toEqual({ status: "available" });
    forgetCredentials(dir, "kick");
    expect(availability()).toEqual({ status: "missing" });
  });
});
