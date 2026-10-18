import React from "react";
import { Flame } from "lucide-react";
import type { KickAccountProgress } from "@lurkloot/shared/models";
import { I18nContext, useT } from "./context";
import { Tip } from "./tooltip";

// Kick's viewer level beside its switch, set as an outlined pill held apart
// from the switch so it reads as a stat rather than the switch's label: the
// level and the daily watch streak, with a bar along the pill's bottom edge
// filling toward the next level. Drawn here rather than Kick's own badge art,
// which stays on Kick.

// Stands in for the level while the short label is split around it.
const LEVEL_SLOT = "\u0001";

// Whole percent toward the next level, rounded down as Kick shows it, so the
// popup never claims a percent the account has not reached yet.
export function kickLevelPercent(progress: KickAccountProgress): number {
  const span = progress.progressXp + progress.xpToNextLevel;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((progress.progressXp * 100) / span)));
}

export function KickAccountProgressView({
  progress,
}: {
  progress: KickAccountProgress;
}): React.ReactElement {
  const t = useT();
  const { locale } = React.useContext(I18nContext);
  const percent = kickLevelPercent(progress);
  const number = new Intl.NumberFormat(locale.replace(/_/g, "-"));
  const streak = progress.streakDays && progress.streakDays > 0 ? progress.streakDays : undefined;
  const summary = t("kickLevelSummary", [
    number.format(progress.level),
    String(percent),
    number.format(progress.level + 1),
  ]);
  const levelLabel = t("kickLevelShort", LEVEL_SLOT).split(LEVEL_SLOT);
  const lines = [
    summary,
    t("kickLevelXp", [
      number.format(progress.progressXp),
      number.format(progress.progressXp + progress.xpToNextLevel),
    ]),
    ...(streak ? [t("kickStreakDays", number.format(streak))] : []),
  ];
  return (
    <Tip label={lines.join("\n")}>
      <div
        role="img"
        aria-label={streak ? `${summary}. ${t("kickStreakDays", number.format(streak))}` : summary}
        data-account-progress="kick"
        className="relative me-1.5 inline-flex shrink-0 items-center overflow-hidden rounded-full border border-[var(--surface-edge)] px-2.5 py-[5px] text-[11px] leading-none"
      >
        <span className="flex items-center gap-1 whitespace-nowrap font-semibold text-zinc-900 tabular dark:text-zinc-50">
          <span>
            {levelLabel[0] ? (
              <span className="font-medium text-zinc-500 dark:text-zinc-400">{levelLabel[0]}</span>
            ) : null}
            <span data-kick-level>{number.format(progress.level)}</span>
            {levelLabel[1] ? (
              <span className="font-medium text-zinc-500 dark:text-zinc-400">{levelLabel[1]}</span>
            ) : null}
          </span>
          {streak ? (
            <>
              <span aria-hidden className="font-medium text-zinc-400 dark:text-zinc-500">
                ·
              </span>
              <span className="flex items-center gap-0.5">
                <Flame
                  size={11}
                  aria-hidden
                  className="shrink-0 text-orange-500 dark:text-orange-400"
                />
                <span data-kick-streak>{number.format(streak)}</span>
              </span>
            </>
          ) : null}
        </span>
        <span
          aria-hidden
          className="absolute inset-x-2.5 bottom-0 h-[2px] overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          {percent > 0 ? (
            <span
              data-kick-level-bar
              className="block h-full rounded-full bg-[var(--platform-kick-text)]"
              style={{ width: `${percent}%` }}
            />
          ) : null}
        </span>
      </div>
    </Tip>
  );
}
