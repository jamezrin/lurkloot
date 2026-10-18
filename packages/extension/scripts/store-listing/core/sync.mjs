async function phase(listing, locale, variant, name, action) {
  try {
    return await action();
  } catch (error) {
    const target = variant ? `${locale}/${variant}` : locale;
    throw new Error(
      `Store listing sync failed for ${target} during ${name}: ${error.message}. ${listing.retryHint(locale)}`,
      { cause: error },
    );
  }
}

export async function setLocaleDescription({
  listing,
  locale,
  description,
  dashboard,
  onProgress = () => {},
}) {
  await phase(listing, locale, undefined, "locale selection", () => dashboard.selectLocale(locale));
  const changed = await phase(listing, locale, undefined, "description edit", () =>
    dashboard.setDescription(description),
  );
  if (!changed) {
    onProgress({ locale, phase: "description-unchanged" });
    return;
  }
  await phase(listing, locale, undefined, "description save", () => dashboard.saveDraft());
  onProgress({ locale, phase: "description-saved" });
}

export async function replaceLocaleScreenshots({
  listing,
  locale,
  files,
  dashboard,
  section = "localized",
  onProgress = () => {},
}) {
  // The global section is shared by every language, so it is filled from the
  // English set once and never follows the language selector.
  if (section === "localized") {
    await phase(listing, locale, undefined, "locale selection", () =>
      dashboard.selectLocale(locale),
    );
  }
  // An empty localized panel is located differently from a populated one, so
  // the check is repeated for every language rather than trusted from preflight.
  await phase(listing, locale, undefined, "section check", () =>
    dashboard.requireDistinctScreenshotSections(),
  );
  const initialCount = await phase(listing, locale, undefined, "screenshot count", () =>
    dashboard.screenshotCount(section),
  );
  if (initialCount > files.length) {
    throw new Error(
      `Store listing sync failed for ${locale} during pre-replacement count: expected at most ${files.length} screenshots, found ${initialCount}. ${listing.retryHint(locale)}`,
    );
  }

  // A new language starts empty and an interrupted run can leave one short,
  // so the set is topped up before the rotation needs a full one.
  let count = initialCount;
  for (const file of files.slice(0, files.length - initialCount)) {
    const variant = file.variant.file;
    await phase(listing, locale, variant, "fill upload", () =>
      dashboard.uploadScreenshot(file.path, section),
    );
    await phase(listing, locale, variant, "fill wait", () =>
      dashboard.waitForScreenshotCount(count + 1, section),
    );
    count += 1;
    onProgress({ locale, variant, phase: initialCount === 0 ? "uploaded" : "recovered", section });
  }

  // Filling an empty set already produced the desired order.
  if (initialCount > 0) {
    for (const file of files) {
      const variant = file.variant.file;
      // Removing the leading image and appending its replacement rotates the
      // set exactly once per image, so the original order is preserved.
      await phase(listing, locale, variant, "removal", () =>
        dashboard.removeFirstScreenshot(section),
      );
      await phase(listing, locale, variant, "post-removal wait", () =>
        dashboard.waitForScreenshotCount(files.length - 1, section),
      );
      await phase(listing, locale, variant, "upload", () =>
        dashboard.uploadScreenshot(file.path, section),
      );
      await phase(listing, locale, variant, "post-upload wait", () =>
        dashboard.waitForScreenshotCount(files.length, section),
      );
      onProgress({ locale, variant, phase: "uploaded", section });
    }
  }

  await phase(listing, locale, undefined, "draft save", () => dashboard.saveDraft());
  onProgress({ locale, phase: "saved", section });
}

// Either map may be omitted to sync only the other part of each listing.
export async function syncStoreListing({
  listing,
  locales,
  filesByLocale,
  descriptionsByLocale,
  dashboard,
  onProgress = () => {},
}) {
  try {
    await dashboard.preflight({
      locales,
      screenshots: Boolean(filesByLocale),
      descriptions: Boolean(descriptionsByLocale),
    });
  } catch (error) {
    throw new Error(`Store listing sync failed during dashboard preflight: ${error.message}`, {
      cause: error,
    });
  }

  for (const locale of locales) {
    if (descriptionsByLocale) {
      const description = descriptionsByLocale.get(locale);
      if (!description) throw new Error(`No validated store description found for ${locale}`);
      await setLocaleDescription({ listing, locale, description, dashboard, onProgress });
    }
    if (filesByLocale) {
      const files = filesByLocale.get(locale);
      if (!files) throw new Error(`No validated screenshot files found for ${locale}`);
      await replaceLocaleScreenshots({ listing, locale, files, dashboard, onProgress });
    }
  }

  // The shared section shows the source locale's artwork, so it is only
  // rewritten when that set was part of this run.
  const sourceLocale = listing.globalScreenshotsFrom;
  const sourceFiles = filesByLocale?.get(sourceLocale);
  if (locales.includes(sourceLocale) && sourceFiles) {
    await replaceLocaleScreenshots({
      listing,
      locale: sourceLocale,
      files: sourceFiles,
      dashboard,
      section: "global",
      onProgress,
    });
  }
}
