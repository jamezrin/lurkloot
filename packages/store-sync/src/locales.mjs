// Locale codes name the directories of a bundle, so they use the extension
// package's own spelling (`pt_BR`). The dashboard spells the same language with
// a hyphen (`pt-BR`) and shows an English name beside it.

const LOCALE_CODE = /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/;

export function isLocaleCode(value) {
  return typeof value === "string" && LOCALE_CODE.test(value);
}

export function dashboardCode(code) {
  return code.replace(/_/g, "-");
}

let displayNames;

// "Japanese" for ja, "Chinese (China)" for zh_CN. Only used to word messages, so
// a runtime without the language data falls back to the code.
export function describeLocale(code) {
  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    return { code, dashboardLabel: displayNames.of(dashboardCode(code)) ?? code };
  } catch {
    return { code, dashboardLabel: code };
  }
}

export function validateLocaleCodes(known, requested) {
  const seen = new Set();
  for (const code of requested) {
    if (!known.includes(code)) {
      throw new Error(`Locale ${code} is not in the bundle. It has: ${known.join(", ")}`);
    }
    if (seen.has(code)) throw new Error(`Duplicate locale ${code}`);
    seen.add(code);
  }
  return [...requested];
}
