// What the app UI knows about running inside the desktop app (#1024, #1026).
// The desktop shell defines DESKTOP_HOST_PROPERTY on the window before the page
// loads (packages/desktop/src-tauri/src/token.rs), and tells the page how a
// Twitch sign-in in its own window ended with TWITCH_SIGN_IN_EVENT
// (packages/desktop/src-tauri/src/twitch_sign_in.rs). In a plain browser
// neither exists and the app keeps the paste flow. The result never carries a
// token or the redirect address.

export const DESKTOP_HOST_PROPERTY = "lurklootDesktop";
export const TWITCH_SIGN_IN_EVENT = "lurkloot:twitch-sign-in";
// The fragment that asks the desktop app for its sign-in window. The shell
// fetches the sign-in link from serve itself; this only marks the request.
export const SIGN_IN_WINDOW_FRAGMENT = "lurkloot-sign-in-window";

export type TwitchSignInResult =
  | { status: "signedIn"; login?: string; environmentOverride: boolean }
  | { status: "cancelled" }
  | { status: "failed"; error: { status?: number; code: string; message: string } };

/** Whether the desktop app opens Twitch's sign-in in a window of its own and
 * reads the redirect itself, so no address has to be pasted. */
export function hasTwitchSignInWindow(target: Window = window): boolean {
  const host: unknown = Reflect.get(target, DESKTOP_HOST_PROPERTY);
  return (
    typeof host === "object"
    && host !== null
    && (host as { twitchSignInWindow?: unknown }).twitchSignInWindow === true
  );
}

function readResult(detail: unknown): TwitchSignInResult | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const value = detail as Record<string, unknown>;
  switch (value.status) {
    case "signedIn":
      return {
        status: "signedIn",
        ...(typeof value.login === "string" ? { login: value.login } : {}),
        environmentOverride: value.environmentOverride === true,
      };
    case "cancelled":
      return { status: "cancelled" };
    case "failed": {
      const error = value.error as Record<string, unknown> | undefined;
      return {
        status: "failed",
        error: {
          ...(typeof error?.status === "number" ? { status: error.status } : {}),
          code: typeof error?.code === "string" ? error.code : "internal_error",
          message: typeof error?.message === "string" ? error.message : "",
        },
      };
    }
    default:
      return undefined;
  }
}

/** Calls the listener with each sign-in outcome the desktop app reports.
 * Returns the unsubscribe function. */
export function onTwitchSignIn(
  listener: (result: TwitchSignInResult) => void,
  target: Window = window,
): () => void {
  const handle = (event: Event) => {
    const result = readResult((event as CustomEvent<unknown>).detail);
    if (result) listener(result);
  };
  target.addEventListener(TWITCH_SIGN_IN_EVENT, handle);
  return () => target.removeEventListener(TWITCH_SIGN_IN_EVENT, handle);
}

// Automatic updates (#1028). The desktop shell finds an update and tells the
// page with DESKTOP_UPDATE_EVENT (packages/desktop/src-tauri/src/updates.rs);
// the page asks for the install by opening the install link, which the shell
// catches. Neither happens in a plain browser.
export const DESKTOP_UPDATE_EVENT = "lurkloot:desktop-update";
export const INSTALL_UPDATE_FRAGMENT = "lurkloot-install-update";
export const INSTALL_UPDATE_LINK = `https://lurkloot.jamezrin.com/guide/headless/desktop#${INSTALL_UPDATE_FRAGMENT}`;

export type DesktopUpdate =
  | { status: "ready"; version: string }
  | { status: "installing"; version: string }
  | { status: "failed"; version: string };

function readUpdate(detail: unknown): DesktopUpdate | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const { status, version } = detail as Record<string, unknown>;
  if (typeof version !== "string" || version === "") return undefined;
  if (status === "ready" || status === "installing" || status === "failed")
    return { status, version };
  return undefined;
}

/** Calls the listener with each update state the desktop app reports.
 * Returns the unsubscribe function. */
export function onDesktopUpdate(
  listener: (update: DesktopUpdate) => void,
  target: Window = window,
): () => void {
  const handle = (event: Event) => {
    const update = readUpdate((event as CustomEvent<unknown>).detail);
    if (update) listener(update);
  };
  target.addEventListener(DESKTOP_UPDATE_EVENT, handle);
  return () => target.removeEventListener(DESKTOP_UPDATE_EVENT, handle);
}
