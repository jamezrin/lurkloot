import { validateLocaleCodes } from "./locales.mjs";

export const ONLY_PARTS = Object.freeze(["descriptions", "screenshots", "global"]);

// What one run touches. The shared group belongs to no language, so it is
// synced when the whole bundle is, or when asked for, and never as a side
// effect of naming one language.
export function resolveScope({ bundle, requestedLocales, only, withGlobal = false }) {
  if (only && !ONLY_PARTS.includes(only)) {
    throw new Error(`--only expects one of ${ONLY_PARTS.join(", ")}`);
  }
  const locales = requestedLocales
    ? validateLocaleCodes(bundle.locales, requestedLocales)
    : [...bundle.locales];

  const wanted = only
    ? {
        descriptions: only === "descriptions",
        screenshots: only === "screenshots",
        global: only === "global",
      }
    : { descriptions: true, screenshots: true, global: !requestedLocales || withGlobal };

  const available = {
    descriptions: locales.some((code) => bundle.scope(code)?.description),
    screenshots: locales.some((code) => bundle.scope(code)?.screenshots),
    global: Boolean(bundle.global?.screenshots),
  };
  if (only && !available[only]) {
    throw new Error(
      only === "global"
        ? "The bundle has no global screenshots"
        : `The bundle has no ${only} for ${locales.join(", ")}`,
    );
  }
  const parts = {
    descriptions: wanted.descriptions && available.descriptions,
    screenshots: wanted.screenshots && available.screenshots,
    global: wanted.global && available.global,
  };
  if (!parts.descriptions && !parts.screenshots && !parts.global) {
    throw new Error("The bundle has nothing to sync for that selection");
  }
  return { locales, parts };
}

// Locales that actually have something in the selected parts.
export function localesWithContent({ bundle, locales, parts }) {
  return locales.filter((code) => {
    const scope = bundle.scope(code);
    return (parts.descriptions && scope?.description) || (parts.screenshots && scope?.screenshots);
  });
}
