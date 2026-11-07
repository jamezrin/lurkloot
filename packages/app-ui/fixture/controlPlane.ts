// A stand-in for `lurkloot serve`'s control plane, for `pnpm dev:fixture`:
// the app's look and flows without a CLI, Twitch or Kick. Campaigns and
// settings come from the popup's own demo data; sign-in is simulated and
// stores nothing. Answers follow serve's shapes and error codes
// (packages/cli/src/runtime/controlPlane.ts, controlPlaneAuth.ts).
//
// Set LURKLOOT_FIXTURE_TOKEN to make it require `Authorization: Bearer`, as a
// non-loopback serve does, to try the access token prompt.
import { createDemoPopupAdapter } from "@lurkloot/popup-ui";
import type { RuntimeMessage, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { ExtensionSettings, Platform } from "@lurkloot/shared/models";
import { applySettingsPatch } from "@lurkloot/shared/settings";

type Answer = { status: number; body: unknown };

const demo = createDemoPopupAdapter({ version: "2.0.0-fixture" });
const SUPPORTED = new Set([
  "getSnapshot",
  "setPlatformEnabled",
  "setAutomation",
  "saveSettings",
  "updateIdleWatchlist",
  "claimReward",
  "selectRewardLane",
  "searchCategories",
  "tickNow",
  "dismissCriticalFailure",
]);
// A few of the settings the CLI config cannot hold, so a refusal can be seen.
const EXTENSION_ONLY = [
  "languageOverride",
  "muteFarmingTabs",
  "diagnosticLogging",
  "twitchExtensions",
];

let settings: ExtensionSettings | undefined;
const signedIn: Record<Platform, boolean> = { twitch: true, kick: false };
interface FixtureDeviceLogin {
  platform: Platform;
  status: "pending" | "approved" | "expired" | "failed" | "cancelled";
  startedAt: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  polls: number;
}
const deviceLogins: Partial<Record<Platform, FixtureDeviceLogin>> = {};

/** Back to the starting state: Twitch signed in, Kick not, demo settings. */
export function resetFixture(): void {
  settings = undefined;
  signedIn.twitch = true;
  signedIn.kick = false;
  delete deviceLogins.twitch;
  delete deviceLogins.kick;
}

function error(status: number, code: string, message: string, paths?: string[]): Answer {
  return { status, body: { error: { code, message, ...(paths ? { paths } : {}) } } };
}

async function snapshot(): Promise<RuntimeSnapshot> {
  const base = await demo.send<RuntimeSnapshot>({ type: "getSnapshot" });
  settings ??= base.settings;
  return {
    settings,
    state: {
      ...base.state,
      lastTickAt: new Date(Date.now() - 42_000).toISOString(),
      authHealth: {
        twitch: signedIn.twitch
          ? base.state.authHealth.twitch
          : { status: "missing_credentials", reasonCode: "credentials_missing" },
        kick: signedIn.kick
          ? base.state.authHealth.kick
          : { status: "missing_credentials", reasonCode: "credentials_missing" },
      },
    },
  };
}

async function handleMessage(message: RuntimeMessage): Promise<Answer> {
  if (!SUPPORTED.has(message.type))
    return error(
      422,
      "unsupported_message",
      `Message type "${message.type}" is not supported by the CLI host`,
    );
  const current = await snapshot();
  switch (message.type) {
    case "saveSettings": {
      const refused = EXTENSION_ONLY.filter((key) => key in message.settingsPatch);
      if (refused.length)
        return error(
          400,
          "settings_unrepresentable",
          "Settings the CLI config cannot hold",
          refused,
        );
      settings = applySettingsPatch(current.settings, message.settingsPatch);
      return { status: 200, body: { result: await snapshot() } };
    }
    case "setAutomation":
    case "setPlatformEnabled":
      settings = applySettingsPatch(current.settings, {
        platform: { [message.platform]: { enabled: message.enabled } },
      });
      return { status: 200, body: { result: await snapshot() } };
    case "searchCategories":
      return { status: 200, body: { result: await demo.send(message) } };
    default:
      return { status: 200, body: { result: current } };
  }
}

function deviceView(login: FixtureDeviceLogin | undefined) {
  if (!login) return null;
  const { polls: _polls, ...view } = login;
  return view;
}

function authView(platform: Platform, auth: RuntimeSnapshot["state"]["authHealth"][Platform]) {
  return {
    auth: {
      ...auth,
      credential: signedIn[platform]
        ? { present: true, source: "stored", status: "checking" }
        : { present: false, source: "none", status: "missing_credentials" },
    },
    deviceLogin: deviceView(deviceLogins[platform]),
  };
}

export async function handleFixtureRequest(
  method: string,
  url: string,
  body: unknown,
  authorization?: string,
): Promise<Answer> {
  const token = process.env.LURKLOOT_FIXTURE_TOKEN;
  if (token && authorization !== `Bearer ${token}`)
    return error(401, "unauthorized", "A valid bearer token is required");
  const path = new URL(url, "http://fixture").pathname;
  const route = `${method} ${path}`;
  if (route === "GET /v1/health") return { status: 200, body: { status: "ok" } };
  if (route === "GET /v1/session") {
    const current = await snapshot();
    return {
      status: 200,
      body: {
        id: "default",
        version: demo.version,
        platforms: {
          twitch: { enabled: current.settings.platform.twitch.enabled },
          kick: { enabled: current.settings.platform.kick.enabled },
        },
      },
    };
  }
  if (route === "POST /v1/session/messages") return handleMessage(body as RuntimeMessage);
  if (route === "GET /v1/session/auth") {
    const current = await snapshot();
    return {
      status: 200,
      body: {
        platforms: {
          twitch: authView("twitch", current.state.authHealth.twitch),
          kick: authView("kick", current.state.authHealth.kick),
        },
      },
    };
  }
  if (route === "GET /v1/session/auth/twitch/browser-login")
    return {
      status: 200,
      body: {
        platform: "twitch",
        // Not Twitch: the fixture never sends anyone to a real sign-in.
        authorizeUrl: "https://example.com/fixture-twitch-sign-in",
        redirectUri: "https://www.twitch.tv/",
      },
    };
  if (route === "POST /v1/session/auth/twitch/browser-login") {
    const address = (body as { address?: unknown } | undefined)?.address;
    if (typeof address !== "string" || !/#access_token=\w+/.test(address))
      return error(400, "invalid_redirect", "The pasted address has no access_token");
    signedIn.twitch = true;
    return {
      status: 200,
      body: { platform: "twitch", environmentOverride: false, login: "fixture_viewer" },
    };
  }
  const match = /^\/v1\/session\/auth\/(twitch|kick)\/(device-login|logout)$/.exec(path);
  if (match) {
    const platform = match[1] as Platform;
    if (match[2] === "logout" && method === "POST") {
      const forgotten = signedIn[platform];
      signedIn[platform] = false;
      delete deviceLogins[platform];
      return { status: 200, body: { platform, forgotten, environmentOverride: false } };
    }
    if (method === "POST") {
      deviceLogins[platform] = {
        platform,
        status: "pending",
        startedAt: new Date().toISOString(),
        verificationUrl:
          platform === "kick"
            ? "https://example.com/fixture-kick-tv"
            : "https://example.com/fixture-activate",
        userCode: platform === "kick" ? "482913" : "WDJB-MJHT",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        polls: 0,
      };
      return { status: 200, body: { deviceLogin: deviceView(deviceLogins[platform]) } };
    }
    const login = deviceLogins[platform];
    if (method === "DELETE") {
      if (login?.status === "pending") login.status = "cancelled";
      return { status: 200, body: { deviceLogin: deviceView(login) } };
    }
    if (method === "GET") {
      // Approved after a few polls, as if the code were confirmed elsewhere.
      if (login?.status === "pending" && ++login.polls >= 15) {
        login.status = "approved";
        signedIn[platform] = true;
      }
      return { status: 200, body: { deviceLogin: deviceView(login) } };
    }
    return error(405, "method_not_allowed", "Method not allowed");
  }
  return error(404, "not_found", "No such endpoint");
}
