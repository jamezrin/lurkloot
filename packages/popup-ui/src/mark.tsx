import * as React from "react";

/** Lurkloot's mark: the icon's progress ring and play glyph, on a matte black
 * tile with a glass sheen. The geometry is the extension icon's
 * (packages/extension/public/icon/source.svg); only the tile is recoloured.
 * Ids come from useId, so two popups — or the site demo's shadow root beside
 * the page — never resolve each other's gradients. */
export function LurklootMark({ size = 24, className }: { size?: number; className?: string }): React.ReactElement {
  const id = React.useId().replace(/:/g, "");
  const tile = `${id}-tile`;
  const sheen = `${id}-sheen`;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden className={className}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2a2a2e" />
          <stop offset="1" stopColor="#09090a" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="4" x2="0" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="30" fill={`url(#${tile})`} />
      <path d="M4 34 C4 17.4 17.4 4 34 4 H94 C110.6 4 124 17.4 124 34 V44 C84 18 44 18 4 44 Z" fill={`url(#${sheen})`} />
      <rect x="4.75" y="4.75" width="118.5" height="118.5" rx="29.25" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="1.5" />
      <circle cx="64" cy="64" r="34" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="9" />
      <path d="M64 30 A34 34 0 1 1 36.2 83.9" stroke="#ffffff" strokeWidth="9" strokeLinecap="round" />
      <path
        fill="#ffffff"
        d="M55 50 C 55 47.2, 58.1 45.6, 60.4 47.1 L 81 60.9 C 83.1 62.3, 83.1 65.7, 81 67.1 L 60.4 80.9 C 58.1 82.4, 55 80.8, 55 78 Z"
      />
    </svg>
  );
}
