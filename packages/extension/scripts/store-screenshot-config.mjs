export const STORE_SCREENSHOT_VARIANTS = Object.freeze([
  Object.freeze({ id: "drops", file: "01-drops", popup: true }),
  Object.freeze({ id: "extras", file: "02-extras", popup: false }),
  Object.freeze({ id: "easy", file: "03-easy", popup: false }),
  Object.freeze({ id: "settings", file: "04-settings", popup: true }),
  Object.freeze({ id: "updated", file: "05-updated", popup: false }),
]);

export const STORE_SCREENSHOT_LOCALES = Object.freeze([
  Object.freeze({ code: "en", dashboardLabel: "English", dashboardNames: ["English"] }),
  Object.freeze({ code: "es", dashboardLabel: "Spanish", dashboardNames: ["Spanish", "Español", "Español – América Latina", "Español - América Latina"] }),
  Object.freeze({ code: "fr", dashboardLabel: "French", dashboardNames: ["French", "Français"] }),
  Object.freeze({ code: "it", dashboardLabel: "Italian", dashboardNames: ["Italian", "Italiano"] }),
  Object.freeze({ code: "ru", dashboardLabel: "Russian", dashboardNames: ["Russian", "Русский"] }),
  Object.freeze({ code: "de", dashboardLabel: "German", dashboardNames: ["German", "Deutsch"] }),
  Object.freeze({ code: "zh_CN", dashboardLabel: "Chinese (Simplified)", dashboardNames: ["Chinese (Simplified)", "Chinese – Simplified", "中文 – 简体"] }),
  Object.freeze({ code: "hi", dashboardLabel: "Hindi", dashboardNames: ["Hindi", "हिंदी"] }),
  Object.freeze({ code: "pt_BR", dashboardLabel: "Portuguese (Brazil)", dashboardNames: ["Portuguese (Brazil)", "Português – Brasil", "Português - Brasil"] }),
  Object.freeze({ code: "ar", dashboardLabel: "Arabic", dashboardNames: ["Arabic", "العربيّة"] }),
  Object.freeze({ code: "tr", dashboardLabel: "Turkish", dashboardNames: ["Turkish", "Türkçe"] }),
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
  let requested;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--validate-only") continue;
    if (argument !== "--locales") {
      throw new Error(`${argument.startsWith("--") ? "Unknown option" : "Unexpected argument"} ${argument}`);
    }
    if (requested) throw new Error("Duplicate option --locales");
    requested = [];
    while (index + 1 < args.length && !args[index + 1].startsWith("--")) {
      requested.push(args[index + 1]);
      index += 1;
    }
  }
  if (!requested) return [...localeCodes];
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
