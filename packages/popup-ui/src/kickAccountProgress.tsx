import React from "react";
import type { KickAccountProgress } from "@lurkloot/shared/models";
import { I18nContext, useT } from "./context";
import { Tip } from "./tooltip";

// Kick's viewer level beside its switch: the level on a gem inside a ring that
// fills clockwise toward the next level, then the daily watch streak. Drawn
// here rather than Kick's own badge art, which stays on Kick.

const BADGE_SIZE = 42;
const RING_RADIUS = 42;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const GEM_SCALE = 0.86;

// Whole percent toward the next level, rounded down as Kick shows it, so the
// popup never claims a percent the account has not reached yet.
export function kickLevelPercent(progress: KickAccountProgress): number {
  const span = progress.progressXp + progress.xpToNextLevel;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((progress.progressXp * 100) / span)));
}

// Sized for the condensed digits; the text length pins the number inside the
// gem even if the condensed face has not loaded.
function levelText(level: number): { size: number; length?: number } {
  const digits = String(level).length;
  if (digits <= 1) return { size: 40 };
  if (digits === 2) return { size: 38, length: 30 };
  return { size: 32, length: 37 };
}

function LevelBadge({ level, percent }: { level: number; percent: number }): React.ReactElement {
  const id = React.useId();
  const text = levelText(level);
  return (
    <svg
      width={BADGE_SIZE}
      height={BADGE_SIZE}
      viewBox="0 0 100 100"
      aria-hidden
      className="shrink-0"
    >
      <defs>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".55" stopColor="#dfe6ff" />
          <stop offset="1" stopColor="#9fb2ff" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6d7dff" />
          <stop offset="1" stopColor="#2a3bd8" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill="#1a1c20" />
      <circle cx="50" cy="50" r={RING_RADIUS} fill="#26292e" />
      <circle cx="50" cy="50" r={RING_RADIUS} fill="none" stroke="#2c4a1c" strokeWidth="8" />
      {percent > 0 ? (
        <circle
          data-kick-level-ring
          cx="50"
          cy="50"
          r={RING_RADIUS}
          fill="none"
          stroke="#53fc18"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(RING_LENGTH * percent) / 100} ${RING_LENGTH}`}
          transform="rotate(-90 50 50)"
        />
      ) : null}
      <g transform={`translate(50 50) scale(${GEM_SCALE}) translate(-50 -50)`}>
        <polygon points="50,20 72,31 72,69 50,80 28,69 28,31" fill={`url(#${id}-face)`} />
        <polygon points="72,31 76,34 76,66 72,69" fill={`url(#${id}-side)`} />
        <polygon points="50,80 72,69 76,66 54,79" fill="#3346e0" opacity=".85" />
        <text
          x="50"
          y="51"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={text.size}
          fill="#0f1430"
          letterSpacing="-0.5"
          textLength={text.length}
          lengthAdjust={text.length ? "spacingAndGlyphs" : undefined}
          style={{
            fontFamily: '"Archivo Condensed Digits", "Archivo Variable", sans-serif',
            fontWeight: 900,
            fontStretch: "62%",
          }}
        >
          {level}
        </text>
      </g>
    </svg>
  );
}

function FlameIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
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
        className="flex shrink-0 items-center gap-1"
      >
        <LevelBadge level={progress.level} percent={percent} />
        {streak ? (
          <span
            data-kick-streak
            className="flex items-center gap-0.5 font-mono text-[11.5px] font-bold tabular text-orange-500 dark:text-orange-400"
          >
            <FlameIcon />
            {number.format(streak)}
          </span>
        ) : null}
      </div>
    </Tip>
  );
}
