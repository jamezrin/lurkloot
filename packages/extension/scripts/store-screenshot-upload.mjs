async function phase(locale, variant, name, action) {
  try {
    return await action();
  } catch (error) {
    const target = variant ? `${locale}/${variant}` : locale;
    throw new Error(`Store screenshot upload failed for ${target} during ${name}: ${error.message}. Retry with: pnpm screenshot:store:upload -- --locales ${locale}`, { cause: error });
  }
}

export async function replaceLocaleScreenshots({ locale, files, dashboard, section = "localized", onProgress = () => {} }) {
  // The global section is shared by every language, so it is filled from the
  // English set once and never follows the language selector.
  if (section === "localized") {
    await phase(locale, undefined, "locale selection", () => dashboard.selectLocale(locale));
  }
  let count = await phase(locale, undefined, "screenshot count", () => dashboard.screenshotCount(section));

  if (count === 4) {
    const recovery = files[0];
    await phase(locale, recovery.variant.file, "interruption recovery upload", () => dashboard.uploadScreenshot(recovery.path, section));
    await phase(locale, recovery.variant.file, "interruption recovery wait", () => dashboard.waitForScreenshotCount(5, section));
    onProgress({ locale, variant: recovery.variant.file, phase: "recovered" });
    count = 5;
  }
  if (count !== 5) {
    throw new Error(`Store screenshot upload failed for ${locale} during pre-replacement count: expected 4 or 5 screenshots, found ${count}. Retry with: pnpm screenshot:store:upload -- --locales ${locale}`);
  }

  for (const file of files) {
    const variant = file.variant.file;
    // Removing the leading image and appending its replacement rotates the set
    // exactly once per image, so the original order is preserved.
    await phase(locale, variant, "removal", () => dashboard.removeFirstScreenshot(section));
    await phase(locale, variant, "post-removal wait", () => dashboard.waitForScreenshotCount(4, section));
    await phase(locale, variant, "upload", () => dashboard.uploadScreenshot(file.path, section));
    await phase(locale, variant, "post-upload wait", () => dashboard.waitForScreenshotCount(5, section));
    onProgress({ locale, variant, phase: "uploaded", section });
  }

  await phase(locale, undefined, "draft save", () => dashboard.saveDraft());
  onProgress({ locale, phase: "saved", section });
}

export async function uploadStoreScreenshots({ locales, filesByLocale, dashboard, onProgress = () => {} }) {
  try {
    await dashboard.preflight({ locales });
  } catch (error) {
    throw new Error(`Store screenshot upload failed during dashboard preflight: ${error.message}`, { cause: error });
  }

  for (const locale of locales) {
    const files = filesByLocale.get(locale);
    if (!files) throw new Error(`No validated screenshot files found for ${locale}`);
    await replaceLocaleScreenshots({ locale, files, dashboard, onProgress });
  }

  // The shared section shows the English artwork, so it is only rewritten when
  // the English set was part of this run.
  const englishFiles = filesByLocale.get("en");
  if (locales.includes("en") && englishFiles) {
    await replaceLocaleScreenshots({ locale: "en", files: englishFiles, dashboard, section: "global", onProgress });
  }
}
