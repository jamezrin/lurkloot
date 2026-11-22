// Navigation order for the user guide (/guide). The guide is written for people
// using Lurkloot, not for contributors: describe what to click and what to
// expect, in the popup's own wording, without implementation details.
import type { CollectionEntry } from "astro:content";

export const GUIDE_SECTIONS = [
  { id: "getting-started", title: "Getting started" },
  { id: "popup", title: "Using the popup" },
  { id: "farming", title: "What it farms" },
  { id: "choosing", title: "Choosing what gets farmed" },
  { id: "settings", title: "Settings" },
  { id: "accounts", title: "Accounts and privacy" },
  { id: "headless", title: "Running without a browser" },
  { id: "troubleshooting", title: "Troubleshooting" },
] as const;

export const SUPPORT_LEVELS = ["yes", "partial", "no"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];
export const SUPPORT_LABELS: Record<SupportLevel, string> = {
  yes: "Yes",
  partial: "Partly",
  no: "No",
};

export type GuideEntry = CollectionEntry<"guide">;

export const guideHref = (entry: GuideEntry) => `/guide/${entry.id}`;

/** Sections in navigation order, each with its pages sorted; empty sections are left out. */
export function groupGuide(entries: GuideEntry[]) {
  return GUIDE_SECTIONS.map((section) => ({
    ...section,
    pages: entries
      .filter((entry) => entry.data.section === section.id)
      .sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title)),
  })).filter((section) => section.pages.length > 0);
}
