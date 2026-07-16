import React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Info } from "lucide-react";
import { CLI_DOCS_URL, GITHUB_NEW_ISSUE_URL } from "./constants";
import { useT } from "./context";

export const TIP_ROTATION_MS = 10_000;

interface TipDescriptor {
  messageKey: string;
  actionKey?: string;
  href?: string;
}

const TIPS: TipDescriptor[] = [
  { messageKey: "tipCampaignPriority" },
  { messageKey: "tipMissingCampaigns" },
  { messageKey: "tipCategorySelection" },
  { messageKey: "tipWatchQueue" },
  { messageKey: "tipTablessMode" },
  { messageKey: "tipCli", actionKey: "tipCliAction", href: CLI_DOCS_URL },
  { messageKey: "tipFeedback", actionKey: "tipFeedbackAction", href: GITHUB_NEW_ISSUE_URL },
  { messageKey: "tipExcludedCampaigns" },
];

export function randomTipIndex(count: number, random: () => number = Math.random): number {
  return count > 0 ? Math.floor(random() * count) : 0;
}

export function nextTipIndex(current: number, count: number): number {
  return count > 0 ? (current + 1) % count : 0;
}

export function createTipRotator({
  onAdvance,
  isVisible,
  setInterval: schedule = (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: cancel = (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
}: {
  onAdvance(): void;
  isVisible(): boolean;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): () => void {
  const handle = schedule(() => {
    if (isVisible()) onAdvance();
  }, TIP_ROTATION_MS);
  return () => cancel(handle);
}

export function TipsBanner({ initialIndex }: { initialIndex?: number }): React.ReactElement {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const [tipIndex, setTipIndex] = React.useState(() => initialIndex ?? randomTipIndex(TIPS.length));

  React.useEffect(() => createTipRotator({
    onAdvance: () => setTipIndex((current) => nextTipIndex(current, TIPS.length)),
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  }), []);

  const tip = TIPS[tipIndex] ?? TIPS[0];
  return (
    <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[11px]" style={{ backgroundColor: "var(--accent-softer)" }}>
      <Info size={13} className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={tip.messageKey}
          initial={reduceMotion ? false : { opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -2 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          className="leading-snug text-zinc-600 dark:text-zinc-300"
        >
          {t(tip.messageKey)}
          {tip.href && tip.actionKey ? (
            <>
              {" "}
              <a
                href={tip.href}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-[var(--accent-text)] underline decoration-current/35 underline-offset-2 hover:decoration-current"
              >
                {t(tip.actionKey)}
              </a>
            </>
          ) : null}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
