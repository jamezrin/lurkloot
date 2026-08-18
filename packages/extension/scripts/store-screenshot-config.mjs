export const STORE_SCREENSHOT_VARIANTS = Object.freeze([
  Object.freeze({ id: "drops", file: "01-drops", popup: true }),
  Object.freeze({ id: "extras", file: "02-extras", popup: false }),
  Object.freeze({ id: "easy", file: "03-easy", popup: false }),
  Object.freeze({ id: "settings", file: "04-settings", popup: true }),
  Object.freeze({ id: "updated", file: "05-updated", popup: false }),
]);

export const STORE_SCREENSHOT_LOCALES = Object.freeze([
  Object.freeze({ code: "en", dashboardLabel: "English" }),
  Object.freeze({ code: "es", dashboardLabel: "Spanish" }),
  Object.freeze({ code: "fr", dashboardLabel: "French" }),
  Object.freeze({ code: "it", dashboardLabel: "Italian" }),
  Object.freeze({ code: "ru", dashboardLabel: "Russian" }),
  Object.freeze({ code: "de", dashboardLabel: "German" }),
  Object.freeze({ code: "zh_CN", dashboardLabel: "Chinese (Simplified)" }),
  Object.freeze({ code: "hi", dashboardLabel: "Hindi" }),
  Object.freeze({ code: "pt_BR", dashboardLabel: "Portuguese (Brazil)" }),
  Object.freeze({ code: "ar", dashboardLabel: "Arabic" }),
  Object.freeze({ code: "tr", dashboardLabel: "Turkish" }),
]);

const localeCodes = STORE_SCREENSHOT_LOCALES.map(({ code }) => code);
const knownLocales = new Set(localeCodes);

export function screenshotFilename(variant) {
  return `lurkloot-${variant.file}-1280x800.png`;
}

export function validateLocaleCodes(requested) {
  const seen = new Set();
  for (const code of requested) {
    if (!knownLocales.has(code)) {
      throw new Error(`Unknown locale ${code}. Known locales: ${localeCodes.join(", ")}`);
    }
    if (seen.has(code)) {
      throw new Error(`Duplicate locale ${code}`);
    }
    seen.add(code);
  }
  return [...requested];
}

export function parseRequestedLocales(args) {
  const marker = args.indexOf("--locales");
  if (marker === -1) return [...localeCodes];
  const requested = [];
  for (let index = marker + 1; index < args.length && !args[index].startsWith("--"); index += 1) {
    requested.push(args[index]);
  }
  if (requested.length === 0) {
    throw new Error("--locales requires at least one locale code");
  }
  return validateLocaleCodes(requested);
}

export function localeConfig(code) {
  const locale = STORE_SCREENSHOT_LOCALES.find((candidate) => candidate.code === code);
  if (!locale) throw new Error(`Unknown locale ${code}`);
  return locale;
}
