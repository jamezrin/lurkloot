import type React from "react";
import { useCallback, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import { ChevronDown, UserRound, UsersRound } from "lucide-react";
import type { Platform, PlatformAuthStatus } from "@lurkloot/shared/models";
import { statusColor } from "./automation";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { FLOATING_POPUP_CLASS } from "./dropdown";
import { usePortalContainer } from "./portal";
import { cn } from "./primitives";

export type AccountStatusTone = "ok" | "muted" | "warning";

/** How an account's sign-in reads: its label key and tone. One mapping for
 * the header's account chip and the host's Accounts page, so the two never
 * disagree. Unknown (not read yet) reads as checking. */
export function accountStatusDisplay(
  status: PlatformAuthStatus | undefined,
): readonly [labelKey: string, tone: AccountStatusTone] {
  switch (status) {
    case "healthy":
      return ["appAccountSignedIn", "ok"];
    case undefined:
    case "checking":
      return ["appAccountChecking", "muted"];
    case "missing_credentials":
      return ["appAccountSignedOut", "muted"];
    case "invalid_credentials":
      return ["appAccountRejected", "warning"];
    default:
      return ["appAccountUnavailable", "warning"];
  }
}

const TONE_DOT: Record<AccountStatusTone, string> = {
  ok: "bg-emerald-500",
  muted: "bg-zinc-400 dark:bg-zinc-500",
  warning: "bg-amber-500",
};
const TONE_TEXT: Record<AccountStatusTone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  muted: "text-zinc-500 dark:text-zinc-400",
  warning: "text-amber-700 dark:text-amber-400",
};

/** The header's account chip for the platform shown: whose account the page
 * is farming with and whether it is signed in. Its menu leads to the host's
 * Accounts page.
 *
 * One account per platform today. The chip is where a second one will be
 * picked: the menu lists the platform's accounts above "Manage accounts", and
 * the page below follows the one chosen, so nothing else has to move. */
export function AccountChip({
  platform,
  status,
  onManage,
}: {
  platform: Platform;
  status: PlatformAuthStatus | undefined;
  onManage(): void;
}): React.ReactElement {
  const t = useT();
  const [portalRef, container] = usePortalContainer();
  const [labelKey, tone] = accountStatusDisplay(status);
  const title = t("windowAccountTitle", PLATFORMS[platform].label);
  const avatar = (
    <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
      <UserRound size={14} aria-hidden />
      <span
        aria-hidden
        className={cn(
          "absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface)]",
          TONE_DOT[tone],
        )}
      />
    </span>
  );
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        ref={portalRef}
        data-account-chip={platform}
        data-account-status={status ?? "loading"}
        aria-label={`${title}: ${t(labelKey)}`}
        className="flex items-center gap-2 rounded-lg border border-[var(--surface-edge)] py-1 ps-1 pe-2 text-start outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[popup-open]:bg-zinc-50 dark:hover:bg-white/[0.04] dark:data-[popup-open]:bg-white/[0.04]"
      >
        {avatar}
        <span className="@max-3xl/header:hidden flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] font-semibold text-zinc-900 dark:text-zinc-50">
            {title}
          </span>
          <span className={cn("truncate text-[11px] font-medium", TONE_TEXT[tone])}>
            {t(labelKey)}
          </span>
        </span>
        <ChevronDown
          size={13}
          aria-hidden
          className="shrink-0 text-zinc-400 transition-transform [[data-popup-open]>&]:rotate-180"
        />
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 outline-none"
        >
          <Menu.Popup
            aria-label={title}
            data-account-menu
            className={cn(FLOATING_POPUP_CLASS, "w-[16rem]")}
          >
            <div className="flex items-center gap-2.5 px-2 py-2">
              {avatar}
              <div className="min-w-0 leading-tight">
                <div className="truncate text-[12px] font-semibold">{title}</div>
                <div className={cn("truncate text-[11px] font-medium", TONE_TEXT[tone])}>
                  {t(labelKey)}
                </div>
              </div>
            </div>
            <div className="-mx-1 my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
            <Menu.Item
              data-account-manage
              onClick={onManage}
              className="flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[12px] font-medium text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-950 dark:text-zinc-200 dark:data-[highlighted]:bg-zinc-800 dark:data-[highlighted]:text-white"
            >
              <UsersRound size={14} aria-hidden className="shrink-0 text-zinc-400" />
              {t("windowAccountManage")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Where a window frame remembers whether its sidebar is collapsed.
export const SIDEBAR_STORAGE_KEY = "lurkloot.window.sidebar";

/** Whether the window's sidebar is collapsed to icons, and the toggle. The
 * user's choice is kept in the host's storage; until they make one the
 * sidebar follows the window: expanded in a wide one, collapsed otherwise. */
export function useSidebarCollapsed(
  store: Pick<Storage, "getItem" | "setItem"> | undefined,
  wideViewport: boolean,
): [boolean, () => void] {
  const [choice, setChoice] = useState<"collapsed" | "expanded" | null>(() => {
    try {
      const stored = store?.getItem(SIDEBAR_STORAGE_KEY);
      return stored === "collapsed" || stored === "expanded" ? stored : null;
    } catch {
      return null;
    }
  });
  const collapsed = choice ? choice === "collapsed" : !wideViewport;
  const toggle = useCallback(() => {
    const next = collapsed ? "expanded" : "collapsed";
    setChoice(next);
    try {
      store?.setItem(SIDEBAR_STORAGE_KEY, next);
    } catch {
      // Storage refused (private mode, quota): the choice lasts this visit.
    }
  }, [collapsed, store]);
  return [collapsed, toggle];
}

/** A window frame's header, across the top of the content: the platform
 * switch, the host's account switcher for that platform, then what that
 * platform is farming and its switch.
 *
 * Platform first, then account: everything below the header is one
 * platform's, and in time one account's, so the two choices that scope the
 * page sit together, ahead of what the page shows. */
export function WindowHeader({
  platform,
  presentation,
  onPlatformChange,
  account,
  status,
  actions,
}: {
  platform: Platform;
  presentation: Record<Platform, AutomationPresentation>;
  onPlatformChange(platform: Platform): void;
  account?: React.ReactNode;
  // The status strip, laid out for the header.
  status: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    // Narrow (below 36rem), the status drops to a row of its own under the
    // platform and account, rather than squeezing its call to action.
    <header
      data-window-header
      className="@container/header flex min-h-[58px] shrink-0 flex-wrap items-center gap-x-3 border-b border-[var(--surface-edge)] bg-[var(--surface)] px-3 py-1"
    >
      <PlatformSwitch active={platform} presentation={presentation} onChange={onPlatformChange} />
      {account ? (
        <div data-window-account className="shrink-0">
          {account}
        </div>
      ) : null}
      <div
        aria-hidden
        className="h-6 w-px shrink-0 bg-[var(--surface-edge)] @max-xl/header:hidden"
      />
      <div className="flex min-w-0 flex-1 @max-xl/header:basis-full">{status}</div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}

/** Twitch and Kick side by side, each with its status dot, so the platform
 * not shown still says how it is getting on. Picking one only shows it; its
 * switch is the strip's. */
function PlatformSwitch({
  active,
  presentation,
  onChange,
}: {
  active: Platform;
  presentation: Record<Platform, AutomationPresentation>;
  onChange(platform: Platform): void;
}): React.ReactElement {
  const t = useT();
  const platformIds = Object.keys(PLATFORMS) as Platform[];
  return (
    <Tabs.Root value={active} onValueChange={(value) => onChange(value as Platform)}>
      <Tabs.List
        data-tour="platform-switch"
        activateOnFocus
        aria-label={t("navPlatform")}
        className="flex shrink-0 gap-0.5 rounded-lg border border-[var(--surface-edge)] bg-zinc-100 p-0.5 dark:bg-zinc-900"
      >
        {platformIds.map((id) => {
          const details = PLATFORMS[id];
          const status = presentation[id];
          const indicatorColor = statusColor(status, details.color);
          return (
            <Tabs.Tab
              key={id}
              value={id}
              aria-label={details.label}
              data-platform-status={id}
              data-state={status.state}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold text-zinc-500 outline-none transition-colors hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[active]:bg-[var(--surface)] data-[active]:text-zinc-900 data-[active]:shadow-sm dark:hover:text-zinc-100 dark:data-[active]:bg-zinc-800 dark:data-[active]:text-zinc-50"
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{
                  backgroundColor: indicatorColor ?? details.color,
                  opacity: indicatorColor ? 1 : 0.35,
                }}
              />
              <span className="@max-lg/header:hidden">{details.label}</span>
            </Tabs.Tab>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
