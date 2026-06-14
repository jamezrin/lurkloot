// Changelog content — the single source of truth for the on-site /changelog page.
// Newest version first. Text is plain (no markup) to keep the page simple.
// The extension deep-links here on update (e.g. /changelog#v1.3.0).

export type ChangeKind = "new" | "improved" | "fixed";

export interface Change {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string; // "1.3.0"
  // ISO date "2026-06-07" of the Chrome Web Store release; formatted on the page.
  // Omit for a version that hasn't been published yet (rendered as "Unreleased").
  date?: string;
  changes: Change[];
}

export const changelog: ChangelogEntry[] = [
  {
    version: "1.3.0",
    changes: [
      { kind: "new", text: "Renamed to Lurkloot." },
      {
        kind: "new",
        text:
          "Streamer and channel names are now clickable links to their channel page — in the watch queue, on each drop's allowed channels, and in the automation view.",
      },
      {
        kind: "new",
        text:
          "Added direct links to each drop's campaign page, plus a “No category” grouping for uncategorized drops.",
      },
      { kind: "new", text: "Added a Chrome Web Store link in the settings footer." },
      {
        kind: "improved",
        text: "Added an occasional one-time prompt to rate the extension.",
      },
      {
        kind: "fixed",
        text: "Corrected the Twitch liveness fallback default and removed dead diagnostics state.",
      },
    ],
  },
  {
    version: "1.2.0",
    date: "2026-06-07",
    changes: [
      { kind: "new", text: "Added a “Priority list only” farming mode." },
      {
        kind: "new",
        text: "Added per-platform category filters and campaign visibility controls.",
      },
      {
        kind: "new",
        text: "Added a per-level activity log control and a reset for excluded campaigns.",
      },
      {
        kind: "new",
        text: "Added campaign lifecycle pills and a start countdown for upcoming campaigns.",
      },
      { kind: "new", text: "Localized the interface and store assets." },
      {
        kind: "improved",
        text: "Tabless background farming is now enabled by default.",
      },
      {
        kind: "improved",
        text: "Reorganized settings into collapsible, grouped sections with a platform switcher.",
      },
      {
        kind: "improved",
        text: "Kick now tries a background fetch before falling back to a page.",
      },
      {
        kind: "fixed",
        text: "Fixed Kick reward images by resolving relative paths to the Kick CDN.",
      },
      { kind: "fixed", text: "Fixed editing automation settings while farming was paused." },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-06-06",
    changes: [
      {
        kind: "fixed",
        text: "Hardened Kick drop auto-claim against the live API so claims register reliably.",
      },
      {
        kind: "fixed",
        text: "More reliable Twitch drop claiming by replaying the page's Client-Integrity token.",
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-06-05",
    changes: [
      {
        kind: "new",
        text:
          "First public release: automatic Twitch and Kick drop farming through your own logged-in session.",
      },
      {
        kind: "new",
        text: "Opt-in tabless low-resource mode that farms without a visible video tab.",
      },
      { kind: "new", text: "Automatic drop claiming, including Twitch channel points." },
      { kind: "new", text: "Activity log panel with adjustable detail levels." },
      {
        kind: "improved",
        text: "Smart channel switching and real campaign progress tracking.",
      },
      { kind: "fixed", text: "Detect already-owned Twitch drops to avoid re-farming them." },
    ],
  },
];
