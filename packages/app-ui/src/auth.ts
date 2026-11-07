import type { Platform, PlatformAuthReasonCode, PlatformAuthStatus } from "@lurkloot/shared/models";
import type { ControlPlaneClient } from "./api";

// The sign-in routes of `lurkloot serve` (#978), typed as the server answers
// them (packages/cli/src/runtime/controlPlaneAuth.ts). The answers carry no
// token, cookie or account id; nothing here stores one either.

export type CredentialSource = "stored" | "environment" | "none";

export interface PlatformAuthView {
  auth: {
    status: PlatformAuthStatus;
    reasonCode?: PlatformAuthReasonCode;
    checkedAt?: string;
    credential: { present: boolean; source: CredentialSource; status: string };
  };
  deviceLogin: DeviceLogin | null;
}

export type DeviceLoginStatus =
  | "starting"
  | "pending"
  | "approved"
  | "expired"
  | "failed"
  | "cancelled";

export interface DeviceLogin {
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
  environmentOverride: boolean;
}

export interface SessionView {
  id: string;
  version: string;
  platforms: Record<Platform, { enabled: boolean }>;
}

export function isDeviceLoginFinished(login: DeviceLogin | null | undefined): boolean {
  return !login || (login.status !== "starting" && login.status !== "pending");
}

export function createAuthApi(client: ControlPlaneClient) {
  return {
    session: () => client.request<SessionView>("GET", "/v1/session"),
    status: () =>
      client.request<{ platforms: Record<Platform, PlatformAuthView> }>("GET", "/v1/session/auth"),
    browserLoginLink: () =>
      client.request<{ platform: "twitch"; authorizeUrl: string; redirectUri: string }>(
        "GET",
        "/v1/session/auth/twitch/browser-login",
      ),
    completeBrowserLogin: (address: string) =>
      client.request<CredentialChange & { login?: string }>(
        "POST",
        "/v1/session/auth/twitch/browser-login",
        { address },
      ),
    startDeviceLogin: (platform: Platform) =>
      client.request<{ deviceLogin: DeviceLogin }>(
        "POST",
        `/v1/session/auth/${platform}/device-login`,
        {},
      ),
    deviceLogin: (platform: Platform) =>
      client.request<{ deviceLogin: DeviceLogin | null }>(
        "GET",
        `/v1/session/auth/${platform}/device-login`,
      ),
    cancelDeviceLogin: (platform: Platform) =>
      client.request<{ deviceLogin: DeviceLogin | null }>(
        "DELETE",
        `/v1/session/auth/${platform}/device-login`,
      ),
    logout: (platform: Platform) =>
      client.request<CredentialChange & { forgotten: boolean }>(
        "POST",
        `/v1/session/auth/${platform}/logout`,
        {},
      ),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
