import React from "react";
import { Globe } from "lucide-react";
import { useT } from "./context";
import { CHROME_WEB_STORE_URL, GITHUB_REPO_URL, SITE_URL } from "./constants";

export function AttributionFooter({ version }: { version: string }): React.ReactElement {
  const t = useT();
  return (
    <footer className="flex h-9 shrink-0 items-center justify-between border-t border-zinc-200/70 bg-white/85 px-3 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-500">
      <span className="text-[10px] font-medium tabular">v{version}</span>
      <nav aria-label={t("attributionLinks")} className="flex items-center gap-0.5">
        <AttributionLink href={SITE_URL} label={t("siteAttribution")} text={t("siteAttributionShort")}>
          <Globe size={13} />
        </AttributionLink>
        <AttributionLink href={CHROME_WEB_STORE_URL} label={t("chromeWebStoreAttribution")} text={t("chromeWebStoreAttributionShort")}>
          <ChromeIcon />
        </AttributionLink>
        <AttributionLink href={GITHUB_REPO_URL} label={t("githubAttribution")} text={t("githubAttributionShort")}>
          <GithubIcon />
        </AttributionLink>
      </nav>
    </footer>
  );
}

// The visible text is a short brand word so three links fit a 36px footer; the
// descriptive string stays as the accessible name and the tooltip.
function AttributionLink({ href, label, text, children }: {
  href: string;
  label: string;
  text: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      {children}
      <span>{text}</span>
    </a>
  );
}

// Brand marks dropped from lucide-react in v1; inlined to keep the footer icons.
function ChromeIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <line x1="21.17" y1="8" x2="12" y2="8" />
      <line x1="3.95" y1="6.06" x2="8.54" y2="14" />
      <line x1="10.88" y1="21.94" x2="15.46" y2="8" />
    </svg>
  );
}

function GithubIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
