import * as React from "react";

/** Lurkloot's mark: the extension icon itself — the progress ring and play glyph
 * on the Twitch-purple to Kick-green tile — drawn inline from
 * packages/extension/public/logo-ring.svg. Ids come from useId, so two popups —
 * or the site demo's shadow root beside the page — never resolve each other's
 * gradients. */
export function LurklootMark({ size = 24, className }: { size?: number; className?: string }): React.ReactElement {
  const id = React.useId().replace(/:/g, "");
  const tile = `${id}-tile`;
  const glyph = `${id}-glyph`;
  const shadow = `${id}-shadow`;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden className={className}>
      <defs>
        <linearGradient id={tile} x1="14" y1="10" x2="116" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a06bff" />
          <stop offset="0.52" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#3fbf12" />
        </linearGradient>
        <linearGradient id={glyph} x1="64" y1="40" x2="64" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef0ff" />
        </linearGradient>
        <filter id={shadow} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#190a3a" floodOpacity="0.30" />
        </filter>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="30" fill={`url(#${tile})`} />
      <path d="M4 34 C4 17.4 17.4 4 34 4 H94 C110.6 4 124 17.4 124 34 V44 C84 18 44 18 4 44 Z" fill="#ffffff" opacity="0.14" />
      <g filter={`url(#${shadow})`}>
        <circle cx="64" cy="64" r="34" stroke="#ffffff" strokeOpacity="0.28" strokeWidth="9" />
        <path d="M64 30 A34 34 0 1 1 36.2 83.9" stroke={`url(#${glyph})`} strokeWidth="9" strokeLinecap="round" />
        <path
          fill={`url(#${glyph})`}
          d="M55 50 C 55 47.2, 58.1 45.6, 60.4 47.1 L 81 60.9 C 83.1 62.3, 83.1 65.7, 81 67.1 L 60.4 80.9 C 58.1 82.4, 55 80.8, 55 78 Z"
        />
      </g>
    </svg>
  );
}
