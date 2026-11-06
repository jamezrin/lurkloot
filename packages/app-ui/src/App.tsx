import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserRound, X } from "lucide-react";
import { openHttpsLink, Popup, type PopupAdapter, type PopupWindowFrame } from "@lurkloot/popup-ui";
import { COMPATIBILITY_REGISTRY } from "@lurkloot/core/compatibility/registry";
import { resolveCompatibility } from "@lurkloot/core/compatibility/resolve";
import type { LanguageOverride } from "@lurkloot/shared/models";
import { AccountsView } from "./accounts";
import { createHttpPopupAdapter } from "./adapter";
import type { ControlPlaneClient } from "./api";
import { createAuthApi } from "./auth";
import { describeMessageError, isConnectionFailure } from "./errors";
import { type AppCatalogs, loadAppCatalogs } from "./i18n";
import type { TokenRequest } from "./tokenPrompt";

type Phase = { kind: "connecting" } | { kind: "unreachable" } | { kind: "ready"; version: string };

// How long a request error stays up unless dismissed.
const NOTICE_MS = 8000;

function openExternal(url: string): void {
  openHttpsLink(url, (safeUrl) => {
    window.open(safeUrl, "_blank", "noopener,noreferrer");
  });
}

export function App({
  client,
  subscribeTokenRequests,
  initialCatalogs,
  storage,
  uiLanguage,
}: {
  client: ControlPlaneClient;
  subscribeTokenRequests(listener: (request: TokenRequest | null) => void): () => void;
  initialCatalogs: AppCatalogs;
  storage: Storage;
  uiLanguage: string;
}): React.ReactElement {
  const [catalogs, setCatalogs] = useState(initialCatalogs);
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [tokenRequest, setTokenRequest] = useState<TokenRequest | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | undefined>();
  const noticeId = useRef(0);
  const { t } = catalogs;
  const tRef = useRef(t);
  tRef.current = t;
  const api = useMemo(() => createAuthApi(client), [client]);

  useEffect(() => subscribeTokenRequests(setTokenRequest), [subscribeTokenRequests]);

  // Whether serve answers at all, and its version, before the popup frame
  // mounts: the frame's first snapshot load has nowhere to show a failure.
  const connect = useCallback(async () => {
    setPhase({ kind: "connecting" });
    try {
      const session = await api.session();
      setPhase({ kind: "ready", version: session.version });
    } catch {
      // Any failure here, a refused Host or Origin included, leaves the app
      // on the retry screen: the frame would only wait on a snapshot forever.
      setPhase({ kind: "unreachable" });
    }
  }, [api]);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The latest language wins, however the catalog loads finish.
  const languageSeq = useRef(0);
  const onLanguageChange = useCallback(
    (language: LanguageOverride) => {
      const seq = ++languageSeq.current;
      void loadAppCatalogs(language, uiLanguage).then((next) => {
        if (seq === languageSeq.current) setCatalogs(next);
      });
    },
    [uiLanguage],
  );

  // The document speaks the app's language, for screen readers and RTL.
  useEffect(() => {
    document.documentElement.lang = catalogs.locale.replace(/_/g, "-");
    document.documentElement.dir = catalogs.dir;
  }, [catalogs.locale, catalogs.dir]);

  const version = phase.kind === "ready" ? phase.version : undefined;
  const adapter = useMemo<PopupAdapter | undefined>(
    () =>
      version === undefined
        ? undefined
        : {
            ...createHttpPopupAdapter({
              client,
              version,
              storage,
              getMessage: initialCatalogs.browserMessage,
              uiLanguage,
              openLink: openExternal,
              onLanguageChange,
              onSuccess: () => setConnectionLost(false),
              onError: (error, message) => {
                if (isConnectionFailure(error)) {
                  setConnectionLost(true);
                  return;
                }
                const text = describeMessageError(error, message, tRef.current);
                if (text) {
                  noticeId.current += 1;
                  setNotice({ id: noticeId.current, text });
                }
              },
            }),
            compatibilityRegistry: COMPATIBILITY_REGISTRY,
            // The CLI host, signed in the recommended way: Twitch's browser
            // sign-in, which is the Android client. The control plane does
            // not say which client the stored sign-in belongs to.
            resolveCompatibility: (settings) =>
              resolveCompatibility(settings, { host: "cli", twitchIdentity: "android" }),
          },
    [client, initialCatalogs.browserMessage, onLanguageChange, storage, uiLanguage, version],
  );

  const windowFrame = useMemo<PopupWindowFrame>(
    () => ({
      hostViews: [
        {
          id: "accounts",
          labelKey: "appNavAccounts",
          icon: UserRound,
          render: () => <AccountsView api={api} />,
        },
      ],
      signInView: "accounts",
    }),
    [api],
  );

  return (
    <div dir={catalogs.dir} className="h-dvh w-full bg-zinc-50 font-sans dark:bg-zinc-950">
      {adapter ? (
        <Popup adapter={adapter} windowFrame={windowFrame} />
      ) : (
        <BootScreen phase={phase} t={t} onRetry={() => void connect()} />
      )}
      {connectionLost ? (
        <div
          role="status"
          data-connection-lost
          className="fixed inset-x-0 top-0 z-50 mx-auto w-fit rounded-b-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-black"
        >
          {t("appConnectionLost")}
        </div>
      ) : null}
      {notice ? (
        <div
          key={notice.id}
          role="alert"
          data-app-notice
          className="fixed bottom-4 end-4 z-50 flex max-w-[28rem] items-start gap-3 rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-[12px] text-zinc-800 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <span className="min-w-0 flex-1 leading-relaxed">{notice.text}</span>
          <button
            type="button"
            aria-label={t("appDismiss")}
            onClick={() => setNotice(undefined)}
            className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {tokenRequest ? <TokenDialog request={tokenRequest} t={t} /> : null}
    </div>
  );
}

function BootScreen({
  phase,
  t,
  onRetry,
}: {
  phase: Phase;
  t: AppCatalogs["t"];
  onRetry(): void;
}): React.ReactElement {
  return (
    <main className="grid h-full place-items-center p-6 text-center">
      {phase.kind === "unreachable" ? (
        <div data-boot="unreachable" className="max-w-sm space-y-3">
          <h1 className="font-display text-lg font-bold text-zinc-900 dark:text-zinc-50">
            {t("appUnreachableTitle")}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("appUnreachableBody")}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-contrast)]"
          >
            {t("appRetry")}
          </button>
        </div>
      ) : (
        <p data-boot="connecting" className="text-sm font-semibold text-zinc-500">
          {t("appConnecting")}
        </p>
      )}
    </main>
  );
}

/** Asks for serve's access token once a request comes back 401. The token is
 * a password-style field that is never echoed back; the client keeps it in
 * sessionStorage. There is no way to dismiss it: nothing works without it. */
function TokenDialog({
  request,
  t,
}: {
  request: TokenRequest;
  t: AppCatalogs["t"];
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal?.();
    inputRef.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      data-token-dialog
      aria-labelledby="token-dialog-title"
      onCancel={(event) => event.preventDefault()}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-800 shadow-2xl backdrop:bg-black/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <form
        method="dialog"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = inputRef.current?.value.trim();
          if (!value) return;
          if (inputRef.current) inputRef.current.value = "";
          request.submit(value);
        }}
      >
        <h2 id="token-dialog-title" className="font-display text-base font-bold">
          {t("appTokenTitle")}
        </h2>
        <p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t("appTokenBody")}
        </p>
        {request.reason === "rejected" ? (
          <p role="alert" className="text-[12px] text-amber-700 dark:text-amber-400">
            {t("appTokenRejected")}
          </p>
        ) : null}
        <input
          ref={inputRef}
          data-token-input
          type="password"
          autoComplete="off"
          aria-label={t("appTokenLabel")}
          placeholder={t("appTokenLabel")}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-950"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            data-token-submit
            className="rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-contrast)]"
          >
            {t("appTokenSubmit")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
