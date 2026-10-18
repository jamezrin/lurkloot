// A listing profile describes one product's store listing to the generic
// tooling in this directory: which languages it has, which screenshots each
// carries, and the few names that would otherwise be hard-coded. Everything
// under core/ takes a profile rather than importing one, so the product-specific
// choices stay in a single module beside it (the adapter module beside core/).

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Listing profile needs a non-empty ${name}`);
  }
  return value;
}

export function defineListing({
  name,
  locales,
  screenshots,
  screenshotSize,
  globalScreenshotsFrom,
  profileApp,
  command,
}) {
  requireNonEmpty(name, "name");
  requireNonEmpty(profileApp, "profileApp");
  requireNonEmpty(command, "command");
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error("Listing profile needs at least one locale");
  }
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    throw new Error("Listing profile needs at least one screenshot variant");
  }
  const codes = locales.map(({ code }) => code);
  if (new Set(codes).size !== codes.length) {
    throw new Error("Listing profile locales must be unique");
  }
  if (!codes.includes(globalScreenshotsFrom)) {
    throw new Error(
      `Listing profile globalScreenshotsFrom ${globalScreenshotsFrom} is not a locale`,
    );
  }
  const known = new Set(codes);

  function validateLocaleCodes(requested) {
    const seen = new Set();
    for (const code of requested) {
      if (!known.has(code)) {
        throw new Error(`Unknown locale ${code}. Known locales: ${codes.join(", ")}`);
      }
      if (seen.has(code)) {
        throw new Error(`Duplicate locale ${code}`);
      }
      seen.add(code);
    }
    return [...requested];
  }

  return Object.freeze({
    name,
    locales: Object.freeze([...locales]),
    localeCodes: Object.freeze(codes),
    screenshots: Object.freeze([...screenshots]),
    screenshotSize: Object.freeze({ ...screenshotSize }),
    globalScreenshotsFrom,
    profileApp,
    // The command an operator reruns, named in every retry hint.
    command,
    validateLocaleCodes,
    screenshotFilename(variant) {
      const { width, height } = screenshotSize;
      return `${name}-${variant.file}-${width}x${height}.png`;
    },
    localeConfig(code) {
      const locale = locales.find((candidate) => candidate.code === code);
      if (!locale) throw new Error(`Unknown locale ${code}`);
      return locale;
    },
    retryHint(locale) {
      return `Retry with: ${command} -- --locales ${locale}`;
    },
  });
}

// Reads "--locales a b c" out of an argument list, ignoring the options other
// stages own, and rejects anything it does not recognise.
export function parseLocaleArguments(listing, args, { allowedFlags = [] } = {}) {
  let requested;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (allowedFlags.includes(argument)) continue;
    if (argument !== "--locales") {
      throw new Error(
        `${argument.startsWith("--") ? "Unknown option" : "Unexpected argument"} ${argument}`,
      );
    }
    if (requested) throw new Error("Duplicate option --locales");
    requested = [];
    while (index + 1 < args.length && !args[index + 1].startsWith("--")) {
      requested.push(args[index + 1]);
      index += 1;
    }
  }
  if (!requested) return [...listing.localeCodes];
  if (requested.length === 0) {
    throw new Error("--locales requires at least one locale code");
  }
  return listing.validateLocaleCodes(requested);
}
