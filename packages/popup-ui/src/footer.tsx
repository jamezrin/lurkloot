import React from "react";
import { Github } from "lucide-react";
import { useT } from "./context";

export function AttributionFooter({ version }: { version: string }): React.ReactElement {
  const t = useT();
  return (
    <footer className="flex h-9 shrink-0 items-center justify-between border-t border-zinc-200/70 bg-white/85 px-3 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-500">
      <span className="text-[10px] font-medium tabular">v{version}</span>
      <nav aria-label={t("attributionLinks")} className="flex items-center gap-1.5">
        <a
          href="https://github.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title={t("githubAttribution")}
          aria-label={t("githubAttribution")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <Github size={15} />
        </a>
        <a
          href="https://x.com/jamezrin"
          target="_blank"
          rel="noreferrer"
          title={t("xAttribution")}
          aria-label={t("xAttribution")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <XLogoIcon />
        </a>
      </nav>
    </footer>
  );
}

function XLogoIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M17.53 3h3.06l-6.68 7.64L21.77 21h-6.16l-4.82-6.3L5.27 21H2.21l7.15-8.17L1.83 3h6.32l4.36 5.76L17.53 3Zm-1.07 16.18h1.7L7.23 4.72H5.41l11.05 14.46Z" />
    </svg>
  );
}
