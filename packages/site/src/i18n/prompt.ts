import type { SupportedLocale } from "@lurkloot/shared/models";

const LOCALE_NAMES: Record<Exclude<SupportedLocale, "en">, string> = {
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ru: "Russian",
  de: "German",
  zh_CN: "Simplified Chinese",
  hi: "Hindi",
  pt_BR: "Brazilian Portuguese",
  ar: "Arabic",
  tr: "Turkish",
};

export function translationSystemPrompt(locale: Exclude<SupportedLocale, "en">): string {
  return [
    `You translate Lurkloot marketing website copy into ${LOCALE_NAMES[locale]} (${locale}).`,
    "Return a JSON array of {\"id\",\"text\"} objects and nothing else. No markdown fences.",
    "Do not translate product or platform names: Lurkloot, Twitch, Kick, Chrome Web Store, GitHub, Docker, GHCR.",
    "Do not translate game titles (Rust, Valorant, Fortnite, and other title-case game names).",
    "Keep farm/farming as the gaming loanword used in Lurkloot's existing popup catalog for this locale.",
    "Preserve HTML tags and attributes exactly (including span class=\"grad-text\" and br). Translate text nodes only.",
    "Do not add quotation marks around the whole translation. Keep placeholders and punctuation.",
  ].join(" ");
}
