import * as React from "react";

/** Lurkloot's mark: the icon's progress ring and play glyph, flat — black on a
 * white tile, so it stands out on the black rail. The geometry is the extension
 * icon's (packages/extension/public/icon/source.svg); only the colours differ. */
export function LurklootMark({ size = 24, className }: { size?: number; className?: string }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden className={className}>
      <rect x="4" y="4" width="120" height="120" rx="30" fill="#ffffff" />
      <circle cx="64" cy="64" r="34" stroke="#0a0a0a" strokeOpacity="0.18" strokeWidth="9" />
      <path d="M64 30 A34 34 0 1 1 36.2 83.9" stroke="#0a0a0a" strokeWidth="9" strokeLinecap="round" />
      <path
        fill="#0a0a0a"
        d="M55 50 C 55 47.2, 58.1 45.6, 60.4 47.1 L 81 60.9 C 83.1 62.3, 83.1 65.7, 81 67.1 L 60.4 80.9 C 58.1 82.4, 55 80.8, 55 78 Z"
      />
    </svg>
  );
}
