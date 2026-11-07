import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import { ExternalLink, KeyRound, LogOut, MonitorSmartphone, X } from "lucide-react";
import { cn, openHttpsLink, usePopupRuntime, useT } from "@lurkloot/popup-ui";
import type { Platform } from "@lurkloot/shared/models";
import { isControlPlaneError } from "./api";
import {
  isDeviceLoginFinished,
  type AuthApi,
  type DeviceLogin,
  type PlatformAuthView,
} from "./auth";
import type { Translate } from "./i18n";

// How often the Accounts view re-reads the masked status, and a device login
// while it waits for approval.
export const ACCOUNTS_POLL_MS = 5000;
export const DEVICE_LOGIN_POLL_MS = 2000;

const PLATFORM_LABEL: Record<Platform, string> = { twitch: "Twitch", kick: "Kick" };

const CARD = "rounded-2xl border border-[var(--surface-edge)] bg-[var(--surface)] p-4";
const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-contrast)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-40";
const SECONDARY_BUTTON =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-800 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800";
const INPUT =
  "min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 outline-none placeholder:font-sans placeholder:text-zinc-400 focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100";

/** Describes a failed sign-in request by its typed code, never by echoing
 * anything the user pasted. */
export function describeAuthError(error: unknown, t: Translate): string {
  if (!isControlPlaneError(error)) return t("appErrorGeneric", "unknown");
  switch (error.code) {
    case "invalid_redirect":
    case "invalid_request":
      return t("appErrorInvalidRedirect");
    case "login_rejected":
      return t("appErrorLoginRejected");
    case "login_cancelled":
      return t("appDeviceLoginCancelled");
    case "upstream_unavailable":
      return t("appErrorUpstreamUnavailable");
    case "network_error":
      return t("appErrorNetwork");
    case "unauthorized":
      return t("appErrorUnauthorized");
    default:
      return t("appErrorGeneric", error.code);
  }
}

type Notice = { tone: "ok" | "error"; text: string };

/** The Accounts view: each platform's masked sign-in status and the CLI's own
 * sign-in flows, over `lurkloot serve`'s sign-in routes. */
export function AccountsView({ api }: { api: AuthApi }): React.ReactElement {
  const t = useT();
  const [status, setStatus] = useState<Record<Platform, PlatformAuthView> | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  // Only the latest status read may land: a poll that started before a
  // sign-in or sign-out must not put the old status back.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const answer = await api.status();
      if (seq !== requestSeq.current) return;
      setStatus(answer.platforms);
      setLoadError(undefined);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(describeAuthError(error, t));
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), ACCOUNTS_POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <section data-accounts className="space-y-3">
      <p className="max-w-[72ch] text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {t("appAccountsIntro")}
      </p>
      {loadError ? (
        <p role="alert" className="text-[12px] text-amber-700 dark:text-amber-400">
          {loadError}
        </p>
      ) : null}
      <div className="grid gap-3 @[900px]:grid-cols-2 @[900px]:items-start">
        <TwitchAccount api={api} view={status?.twitch} onChanged={refresh} />
        <KickAccount api={api} view={status?.kick} onChanged={refresh} />
      </div>
    </section>
  );
}

function AccountHeader({
  platform,
  view,
}: {
  platform: Platform;
  view?: PlatformAuthView;
}): React.ReactElement {
  const t = useT();
  const auth = view?.auth;
  const [labelKey, tone] = !auth
    ? (["appAccountChecking", "muted"] as const)
    : auth.status === "healthy"
      ? (["appAccountSignedIn", "ok"] as const)
      : auth.status === "checking"
        ? (["appAccountChecking", "muted"] as const)
        : auth.status === "missing_credentials"
          ? (["appAccountSignedOut", "muted"] as const)
          : auth.status === "invalid_credentials"
            ? (["appAccountRejected", "warning"] as const)
            : (["appAccountUnavailable", "warning"] as const);
  const source = auth?.credential.source;
  return (
    <header className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-[15px] font-bold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
          {PLATFORM_LABEL[platform]}
        </h2>
        <span
          data-account-status={auth?.status ?? "loading"}
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            tone === "ok" && "bg-[var(--ink)] text-[var(--ink-contrast)]",
            tone === "muted" && "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
            tone === "warning"
              && "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
          )}
        >
          {t(labelKey)}
        </span>
        {source && source !== "none" ? (
          <span className="ms-auto text-[11px] text-zinc-500 dark:text-zinc-400">
            {t(source === "environment" ? "appAccountSourceEnvironment" : "appAccountSourceStored")}
          </span>
        ) : null}
      </div>
      {source === "environment" ? <EnvironmentNote /> : null}
    </header>
  );
}

function EnvironmentNote(): React.ReactElement {
  const t = useT();
  return (
    <p
      data-environment-override
      className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
    >
      {t("appAccountEnvironmentNote")}
    </p>
  );
}

function NoticeLine({ notice }: { notice?: Notice }): React.ReactElement | null {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      data-account-notice={notice.tone}
      className={cn(
        "text-[12px]",
        notice.tone === "error"
          ? "text-amber-700 dark:text-amber-400"
          : "text-zinc-700 dark:text-zinc-200",
      )}
    >
      {notice.text}
    </p>
  );
}

function SignOut({
  api,
  platform,
  view,
  onChanged,
}: {
  api: AuthApi;
  platform: Platform;
  view?: PlatformAuthView;
  onChanged(): void;
}): React.ReactElement | null {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  if (view?.auth.credential.source !== "stored" && !notice) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--surface-edge)] pt-3">
      {view?.auth.credential.source === "stored" ? (
        <button
          type="button"
          data-account-logout={platform}
          disabled={busy}
          className={SECONDARY_BUTTON}
          onClick={async () => {
            setBusy(true);
            setNotice(undefined);
            try {
              const result = await api.logout(platform);
              setNotice({
                tone: "ok",
                text: result.environmentOverride
                  ? t("appAccountSignedOutEnvironment")
                  : t(result.forgotten ? "appAccountSignedOutDone" : "appAccountNothingToForget"),
              });
              onChanged();
            } catch (error) {
              setNotice({ tone: "error", text: describeAuthError(error, t) });
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={13} aria-hidden />
          {t("appAccountSignOut")}
        </button>
      ) : null}
      <NoticeLine notice={notice} />
    </div>
  );
}

function Method({
  icon: Icon,
  title,
  badge,
  description,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  badge?: string;
  description: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-2.5 border-t border-[var(--surface-edge)] pt-3">
      <div className="flex items-start gap-2">
        <Icon size={15} className="mt-0.5 shrink-0 text-zinc-500" />
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
            {title}
            {badge ? (
              <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] font-semibold text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                {badge}
              </span>
            ) : null}
          </h3>
          <p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        </div>
      </div>
      <div className="space-y-2 ps-[23px]">{children}</div>
    </div>
  );
}

function TwitchAccount({
  api,
  view,
  onChanged,
}: {
  api: AuthApi;
  view?: PlatformAuthView;
  onChanged(): void;
}): React.ReactElement {
  const t = useT();
  return (
    <article data-account="twitch" className={cn(CARD, "space-y-3")}>
      <AccountHeader platform="twitch" view={view} />
      <BrowserLogin api={api} onChanged={onChanged} />
      <Method
        icon={MonitorSmartphone}
        title={t("appTwitchDeviceLoginTitle")}
        description={t("appTwitchDeviceLoginDescription")}
      >
        <DeviceLoginFlow
          api={api}
          platform="twitch"
          initial={view?.deviceLogin}
          onChanged={onChanged}
        />
      </Method>
      <SignOut api={api} platform="twitch" view={view} onChanged={onChanged} />
    </article>
  );
}

function KickAccount({
  api,
  view,
  onChanged,
}: {
  api: AuthApi;
  view?: PlatformAuthView;
  onChanged(): void;
}): React.ReactElement {
  const t = useT();
  return (
    <article data-account="kick" className={cn(CARD, "space-y-3")}>
      <AccountHeader platform="kick" view={view} />
      <Method
        icon={MonitorSmartphone}
        title={t("appKickDeviceLoginTitle")}
        description={t("appKickDeviceLoginDescription")}
      >
        <DeviceLoginFlow
          api={api}
          platform="kick"
          initial={view?.deviceLogin}
          onChanged={onChanged}
          phoneOnly
        />
      </Method>
      <SignOut api={api} platform="kick" view={view} onChanged={onChanged} />
    </article>
  );
}

/** Twitch's browser sign-in: open the link, sign in, paste back the address
 * Twitch ended on. The pasted address holds the token, so it leaves the input
 * as soon as it is sent, whatever the answer, and is never stored or shown. */
export function BrowserLogin({
  api,
  onChanged,
}: {
  api: AuthApi;
  onChanged(): void;
}): React.ReactElement {
  const t = useT();
  const { adapter } = usePopupRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasAddress, setHasAddress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [environmentOverride, setEnvironmentOverride] = useState(false);

  const openLink = async () => {
    setNotice(undefined);
    try {
      const link = await api.browserLoginLink();
      openHttpsLink(link.authorizeUrl, adapter.openLink);
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error, t) });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const address = input.value.trim();
    // Uncontrolled, and cleared before the request: the address never sits in
    // React state, and is gone from the page whatever the server answers.
    input.value = "";
    setHasAddress(false);
    if (!address) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.completeBrowserLogin(address);
      setEnvironmentOverride(result.environmentOverride);
      setNotice({
        tone: "ok",
        text: result.login
          ? t("appTwitchBrowserLoginDoneAs", result.login)
          : t("appTwitchBrowserLoginDone"),
      });
      onChanged();
    } catch (error) {
      setNotice({ tone: "error", text: describeAuthError(error, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Method
      icon={KeyRound}
      title={t("appTwitchBrowserLoginTitle")}
      badge={t("appRecommended")}
      description={t("appTwitchBrowserLoginDescription")}
    >
      <ol className="list-decimal space-y-2 ps-4 text-[12px] leading-relaxed text-zinc-600 marker:text-zinc-400 dark:text-zinc-300">
        <li>
          <span>{t("appTwitchBrowserLoginStepOpen")}</span>{" "}
          <button
            type="button"
            data-browser-login-open
            onClick={() => void openLink()}
            className={cn(SECONDARY_BUTTON, "ms-1 py-1")}
          >
            <ExternalLink size={12} aria-hidden />
            {t("appTwitchBrowserLoginOpen")}
          </button>
        </li>
        <li>{t("appTwitchBrowserLoginStepCopy", "https://www.twitch.tv/#access_token=…")}</li>
        <li>
          <form onSubmit={(event) => void submit(event)} className="mt-1 flex gap-2">
            <input
              ref={inputRef}
              data-browser-login-address
              // Masked: the address carries the Twitch token.
              type="password"
              name="twitch-redirect"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={t("appTwitchBrowserLoginAddressLabel")}
              placeholder={t("appTwitchBrowserLoginAddressLabel")}
              onChange={(event) => setHasAddress(Boolean(event.target.value.trim()))}
              className={INPUT}
            />
            <button
              type="submit"
              data-browser-login-submit
              disabled={busy || !hasAddress}
              className={PRIMARY_BUTTON}
            >
              {t("appTwitchBrowserLoginSubmit")}
            </button>
          </form>
        </li>
      </ol>
      <NoticeLine notice={notice} />
      {environmentOverride ? <EnvironmentNote /> : null}
      <details className="group rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-[12px] dark:border-zinc-700">
        <summary className="cursor-pointer font-semibold text-zinc-700 marker:text-zinc-400 dark:text-zinc-200">
          {t("appTwitchBrowserLoginFallbackTitle")}
        </summary>
        <p className="mt-1.5 leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t("appTwitchBrowserLoginFallbackBody")}
        </p>
      </details>
    </Method>
  );
}

/** Whether this screen is a phone or tablet, where a link meant for a phone
 * app opens in that app. */
function isTouchScreen(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** A QR code for a link, drawn dark on white whatever the theme so a phone
 * camera reads it. */
function QrCode({ value, label }: { value: string; label: string }): React.ReactElement {
  const path = useMemo(() => {
    const { data } = encode(value, { border: 2 });
    let d = "";
    data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { d, size: data.length };
  }, [value]);
  return (
    <svg
      data-device-login-qr
      role="img"
      aria-label={label}
      viewBox={`0 0 ${path.size} ${path.size}`}
      shapeRendering="crispEdges"
      className="size-36 shrink-0 rounded-lg bg-white"
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** A device-code sign-in (Twitch) or TV link (Kick): show the link and code,
 * poll until the server says how it ended, and let the user cancel.
 * `phoneOnly` is for a link only a phone app opens (Kick's TV link has no
 * page on the desktop site): it is shown as a QR code, and offered as a link
 * only on a touch screen. */
export function DeviceLoginFlow({
  api,
  platform,
  initial,
  onChanged,
  phoneOnly = false,
}: {
  api: AuthApi;
  platform: Platform;
  initial?: DeviceLogin | null;
  onChanged(): void;
  phoneOnly?: boolean;
}): React.ReactElement {
  const t = useT();
  const { adapter } = usePopupRuntime();
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const adopted = useRef(false);

  // Pick up a login already running when the view opens (another tab, a
  // reload), but only once: later status polls must not undo a cancel.
  useEffect(() => {
    if (adopted.current || initial === undefined) return;
    adopted.current = true;
    if (initial && !isDeviceLoginFinished(initial)) setLogin(initial);
  }, [initial]);

  const pending = Boolean(login && !isDeviceLoginFinished(login));
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const interval = setInterval(() => {
      void api.deviceLogin(platform).then(
        (answer) => {
          if (cancelled) return;
          setLogin(answer.deviceLogin);
          if (answer.deviceLogin?.status === "approved") onChanged();
        },
        () => undefined, // a missed poll is retried by the next one
      );
    }, DEVICE_LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, onChanged, pending, platform]);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setLogin((await api.startDeviceLogin(platform)).deviceLogin);
    } catch (failure) {
      setError(describeAuthError(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const answer = await api.cancelDeviceLogin(platform);
      setLogin(answer.deviceLogin);
    } catch (failure) {
      setError(describeAuthError(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const outcome = login ? deviceOutcome(login, t) : undefined;
  const offerLink = !phoneOnly || isTouchScreen();

  return (
    <div
      data-device-login={platform}
      data-device-login-status={login?.status ?? "idle"}
      className="space-y-2"
    >
      {pending && login?.verificationUrl && login.userCode ? (
        <div className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="text-[10.5px] font-medium text-zinc-500">
                {t("appDeviceLoginCode")}
              </div>
              <div
                data-device-login-code
                className="font-mono text-[20px] font-semibold tracking-[0.12em] text-zinc-900 dark:text-zinc-50"
              >
                {login.userCode}
              </div>
            </div>
            <div className="ms-auto flex gap-2">
              {offerLink ? (
                <button
                  type="button"
                  data-device-login-open
                  className={PRIMARY_BUTTON}
                  onClick={() => openHttpsLink(login.verificationUrl!, adapter.openLink)}
                >
                  <ExternalLink size={12} aria-hidden />
                  {t("appDeviceLoginOpen")}
                </button>
              ) : null}
              <button
                type="button"
                data-device-login-cancel
                disabled={busy}
                className={SECONDARY_BUTTON}
                onClick={() => void cancel()}
              >
                <X size={12} aria-hidden />
                {t("appDeviceLoginCancel")}
              </button>
            </div>
          </div>
          {phoneOnly ? (
            <div className="flex flex-wrap items-center gap-3">
              <QrCode value={login.verificationUrl} label={t("appDeviceLoginQrLabel")} />
              <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                {t("appKickDeviceLoginScan")}
              </p>
            </div>
          ) : null}
          {offerLink ? (
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate font-mono text-[11px] text-zinc-500 underline decoration-dotted underline-offset-2 dark:text-zinc-400"
            >
              {login.verificationUrl}
            </a>
          ) : null}
          <p role="status" className="text-[12px] text-zinc-500 dark:text-zinc-400">
            {t("appDeviceLoginWaiting")}
          </p>
        </div>
      ) : (
        <button
          type="button"
          data-device-login-start
          disabled={busy || pending}
          className={SECONDARY_BUTTON}
          onClick={() => void start()}
        >
          {t("appDeviceLoginStart")}
        </button>
      )}
      <NoticeLine notice={error ? { tone: "error", text: error } : outcome} />
    </div>
  );
}

function deviceOutcome(login: DeviceLogin, t: Translate): Notice | undefined {
  switch (login.status) {
    case "approved":
      return { tone: "ok", text: t("appDeviceLoginApproved") };
    case "expired":
      return { tone: "error", text: t("appDeviceLoginExpired") };
    case "failed":
      return { tone: "error", text: t("appDeviceLoginFailed") };
    case "cancelled":
      return { tone: "ok", text: t("appDeviceLoginCancelled") };
    default:
      return undefined;
  }
}
