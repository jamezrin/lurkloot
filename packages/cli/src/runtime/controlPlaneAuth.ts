import type { Platform } from "@lurkloot/shared/models";
import { errorMessage } from "@lurkloot/shared/errors";
import { describeCredentialHealth, forgetCredentials, saveCredentials } from "../authStore";
import {
  DeviceLoginExpiredError,
  waitForDeviceApproval,
  type DeviceLoginFlow,
  type Sleep,
} from "../auth/deviceLogin";
import { startKickDeviceLogin } from "../auth/kickDeviceFlow";
import {
  completeTwitchBrowserLogin,
  TWITCH_BROWSER_LOGIN_REDIRECT_URI,
  TwitchRedirectError,
  TwitchTokenRejectedError,
  twitchAndroidAuthorizeUrl,
} from "../auth/twitchBrowserLogin";
import { startTwitchDeviceLogin } from "../auth/twitchDeviceFlow";
import type { Logger } from "../logger";
import {
  RequestError,
  type ControlPlaneRoute,
  type SessionPlatformView,
  type SessionView,
} from "./controlPlane";

// `serve`'s sign-in routes (#978). They run the CLI's own login flows (the
// modules in src/auth/), never a new credential path, and write the same
// private auth store the `auth` commands write. No response and no log line
// carries a token, the pasted address, or a Twitch device code; the Kick link
// (whose uuid and code let anyone collect the token once approved) goes to the
// caller only, never to the log.

const PLATFORMS: readonly Platform[] = ["twitch", "kick"];
const PLATFORM_LABEL: Record<Platform, string> = { twitch: "Twitch", kick: "Kick" };
// The redirect address is a URL; anything longer is not one.
const MAX_ADDRESS_LENGTH = 8 * 1024;

export type DeviceLoginStatus =
  | "starting"
  | "pending"
  | "approved"
  | "expired"
  | "failed"
  | "cancelled";

export interface DeviceLoginView {
  platform: Platform;
  status: DeviceLoginStatus;
  startedAt: string;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  finishedAt?: string;
  error?: { message: string };
}

export interface CredentialChange {
  platform: Platform;
  // An SA_* environment variable still supplies this platform's credential,
  // so the engine keeps using it whatever the store holds.
  environmentOverride: boolean;
}

export interface AuthFlowsOptions {
  authDir: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  startDeviceLogin?: Partial<Record<Platform, (signal: AbortSignal) => Promise<DeviceLoginFlow>>>;
  sleep?: Sleep;
  now?: () => number;
  // Called after the store changed (sign-in or logout), e.g. to request a tick.
  onCredentialsChanged?: (platform: Platform) => void;
}

interface FlowRecord {
  abort: AbortController;
  view: DeviceLoginView;
  done: Promise<void>;
}

export interface AuthFlows {
  deviceLogin(platform: Platform): DeviceLoginView | null;
  startDeviceLogin(platform: Platform): Promise<DeviceLoginView>;
  cancelDeviceLogin(platform: Platform): Promise<DeviceLoginView | null>;
  completeTwitchBrowserLogin(address: string): Promise<CredentialChange & { login?: string }>;
  logout(platform: Platform): Promise<CredentialChange & { forgotten: boolean }>;
  close(): Promise<void>;
}

// One in-flight device login per platform. Starting another, a browser
// sign-in, a logout or close() cancels it: its signal aborts the sleep and the
// in-flight poll, and a late approval is dropped before anything is saved.
export function createAuthFlows(options: AuthFlowsOptions): AuthFlows {
  const { authDir, logger } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const records: Partial<Record<Platform, FlowRecord>> = {};
  let closed = false;

  const starters: Record<Platform, (signal: AbortSignal) => Promise<DeviceLoginFlow>> = {
    twitch:
      options.startDeviceLogin?.twitch
      ?? (() => startTwitchDeviceLogin(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})),
    kick: options.startDeviceLogin?.kick ?? (() => startKickDeviceLogin()),
  };

  const environmentOverride = (platform: Platform) =>
    describeCredentialHealth(authDir, env)[platform].source === "environment";

  const changed = (platform: Platform) => {
    try {
      options.onCredentialsChanged?.(platform);
    } catch (error) {
      logger.warn(errorMessage(error), "serve");
    }
  };

  const cancel = async (platform: Platform): Promise<DeviceLoginView | null> => {
    const record = records[platform];
    if (!record) return null;
    record.abort.abort();
    await record.done;
    return { ...record.view };
  };

  const finish = (record: FlowRecord, status: DeviceLoginStatus, message?: string) => {
    record.view = {
      ...record.view,
      status,
      finishedAt: iso(),
      ...(message ? { error: { message } } : {}),
    };
  };

  const drive = async (platform: Platform, record: FlowRecord, flow: DeviceLoginFlow) => {
    const { signal } = record.abort;
    try {
      const token = await waitForDeviceApproval(flow, {
        signal,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        now,
      });
      // A cancelled or replaced flow saves nothing, even if it was approved.
      if (signal.aborted) {
        finish(record, "cancelled");
        return;
      }
      saveCredentials(authDir, flow.credentials(token));
      finish(record, "approved");
      logger.info(`${PLATFORM_LABEL[platform]} device login complete; token saved`, "serve");
      changed(platform);
    } catch (error) {
      if (signal.aborted) finish(record, "cancelled");
      else if (error instanceof DeviceLoginExpiredError) {
        finish(record, "expired", error.message);
        logger.info(`${PLATFORM_LABEL[platform]} device login expired`, "serve");
      } else {
        finish(record, "failed", errorMessage(error));
        logger.warn(
          `${PLATFORM_LABEL[platform]} device login failed: ${errorMessage(error)}`,
          "serve",
        );
      }
    } finally {
      // Disposing (Kick's cycletls exit) can reject a poll still in flight;
      // that is the cancel, not a failure.
      await flow.dispose().catch((error: unknown) => logger.debug(errorMessage(error), "serve"));
    }
  };

  return {
    deviceLogin: (platform) => {
      const record = records[platform];
      return record ? { ...record.view } : null;
    },

    async startDeviceLogin(platform) {
      if (closed) throw new RequestError(503, "shutting_down", "The server is shutting down");
      await cancel(platform);
      const abort = new AbortController();
      let settle: () => void = () => {};
      const record: FlowRecord = {
        abort,
        view: { platform, status: "starting", startedAt: iso() },
        done: new Promise<void>((resolveDone) => {
          settle = resolveDone;
        }),
      };
      records[platform] = record;
      let flow: DeviceLoginFlow;
      try {
        flow = await starters[platform](abort.signal);
      } catch (error) {
        if (abort.signal.aborted) finish(record, "cancelled");
        else finish(record, "failed", errorMessage(error));
        settle();
        if (abort.signal.aborted)
          throw new RequestError(409, "login_cancelled", "The sign-in was cancelled");
        logger.warn(
          `${PLATFORM_LABEL[platform]} device login could not start: ${errorMessage(error)}`,
          "serve",
        );
        throw new RequestError(
          502,
          "upstream_unavailable",
          `Could not start the ${PLATFORM_LABEL[platform]} sign-in: ${errorMessage(error)}`,
        );
      }
      if (abort.signal.aborted) {
        finish(record, "cancelled");
        await flow.dispose().catch(() => undefined);
        settle();
        throw new RequestError(409, "login_cancelled", "The sign-in was cancelled");
      }
      record.view = {
        ...record.view,
        status: "pending",
        verificationUrl: flow.verificationUrl,
        userCode: flow.userCode,
        expiresAt: new Date(now() + flow.expiresInMs).toISOString(),
      };
      logger.info(`${PLATFORM_LABEL[platform]} device login started`, "serve");
      void drive(platform, record, flow).finally(settle);
      return { ...record.view };
    },

    cancelDeviceLogin: cancel,

    async completeTwitchBrowserLogin(address) {
      if (closed) throw new RequestError(503, "shutting_down", "The server is shutting down");
      if (address.length > MAX_ADDRESS_LENGTH)
        throw new RequestError(400, "invalid_redirect", "That is not a Twitch redirect address");
      let validated: Awaited<ReturnType<typeof completeTwitchBrowserLogin>>;
      try {
        validated = await completeTwitchBrowserLogin(authDir, address, options.fetchImpl);
      } catch (error) {
        if (error instanceof TwitchRedirectError)
          throw new RequestError(400, "invalid_redirect", error.message);
        if (error instanceof TwitchTokenRejectedError)
          throw new RequestError(422, "login_rejected", error.message);
        logger.warn(`Twitch browser login: ${errorMessage(error)}`, "serve");
        throw new RequestError(
          502,
          "upstream_unavailable",
          "Could not reach Twitch to check the token",
        );
      }
      // The browser sign-in replaced the login; a device login still pending
      // must not overwrite it when it is approved later.
      await cancel("twitch");
      logger.info("Twitch browser login complete; token saved", "serve");
      changed("twitch");
      return {
        platform: "twitch",
        environmentOverride: environmentOverride("twitch"),
        ...(validated.login ? { login: validated.login } : {}),
      };
    },

    async logout(platform) {
      await cancel(platform);
      const forgotten = forgetCredentials(authDir, platform);
      logger.info(
        forgotten
          ? `Forgot stored ${platform} credentials`
          : `No stored ${platform} credentials to forget`,
        "serve",
      );
      if (forgotten) changed(platform);
      return { platform, forgotten, environmentOverride: environmentOverride(platform) };
    },

    async close() {
      closed = true;
      await Promise.all(PLATFORMS.map((platform) => cancel(platform)));
    },
  };
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new RequestError(400, "invalid_request", "The body must be a JSON object");
  return body as Record<string, unknown>;
}

export interface AuthPlatformView extends Omit<SessionPlatformView, "enabled"> {
  deviceLogin: DeviceLoginView | null;
}

// The sign-in routes, all under the session:
//   GET    /v1/session/auth                         both platforms' masked status
//   GET    /v1/session/auth/twitch/browser-login    the sign-in link to open
//   POST   /v1/session/auth/twitch/browser-login    { address } the page Twitch ended on
//   POST   /v1/session/auth/:platform/device-login  start (replaces one in flight)
//   GET    /v1/session/auth/:platform/device-login  its status
//   DELETE /v1/session/auth/:platform/device-login  cancel it
//   POST   /v1/session/auth/:platform/logout        forget the stored credential
export function createAuthRoutes(
  flows: AuthFlows,
  describeSession: () => Promise<SessionView>,
): ControlPlaneRoute[] {
  const routes: ControlPlaneRoute[] = [
    {
      method: "GET",
      path: "/v1/session/auth",
      handle: async () => {
        const session = await describeSession();
        const view = (platform: Platform): AuthPlatformView => ({
          auth: session.platforms[platform].auth,
          deviceLogin: flows.deviceLogin(platform),
        });
        return { body: { platforms: { twitch: view("twitch"), kick: view("kick") } } };
      },
    },
    {
      method: "GET",
      path: "/v1/session/auth/twitch/browser-login",
      handle: async () => ({
        body: {
          platform: "twitch",
          authorizeUrl: twitchAndroidAuthorizeUrl(),
          redirectUri: TWITCH_BROWSER_LOGIN_REDIRECT_URI,
        },
      }),
    },
    {
      method: "POST",
      path: "/v1/session/auth/twitch/browser-login",
      handle: async (body) => {
        const address = parseObjectBody(body).address;
        if (typeof address !== "string")
          throw new RequestError(
            400,
            "invalid_request",
            "Send { address }: the https://www.twitch.tv/#access_token=… address Twitch ended on",
          );
        return { body: await flows.completeTwitchBrowserLogin(address) };
      },
    },
  ];
  for (const platform of PLATFORMS) {
    const base = `/v1/session/auth/${platform}`;
    routes.push(
      {
        method: "POST",
        path: `${base}/device-login`,
        handle: async () => ({ body: { deviceLogin: await flows.startDeviceLogin(platform) } }),
      },
      {
        method: "GET",
        path: `${base}/device-login`,
        handle: async () => ({ body: { deviceLogin: flows.deviceLogin(platform) } }),
      },
      {
        method: "DELETE",
        path: `${base}/device-login`,
        handle: async () => ({ body: { deviceLogin: await flows.cancelDeviceLogin(platform) } }),
      },
      {
        method: "POST",
        path: `${base}/logout`,
        handle: async () => ({ body: await flows.logout(platform) }),
      },
    );
  }
  return routes;
}
