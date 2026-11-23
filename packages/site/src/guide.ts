// The user guide (/guide), built with Starlight. It is written for people using
// Lurkloot, not for contributors: describe what to click and what to expect, in
// the popup's own wording, without implementation details.
//
// Each section is a folder under src/content/docs/guide/; this list sets the
// order and the name the sidebar and the guide's home page show for it.
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

export interface GuideSupport {
  extension: SupportLevel;
  cli: SupportLevel;
  note?: string;
}

/** The URL of a guide page from its Starlight entry id ("guide/farming/nopixel"). */
export const guideHref = (id: string) => `/${id.replace(/\/index$/, "")}`;

/** The section folder a guide page sits in, or undefined for the guide's home page. */
export const guideSectionOf = (id: string) => id.split("/")[1];
