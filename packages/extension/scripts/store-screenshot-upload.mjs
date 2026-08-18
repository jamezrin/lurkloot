async function phase(locale, variant, name, action) {
  try {
    return await action();
  } catch (error) {
    const target = variant ? `${locale}/${variant}` : locale;
    throw new Error(`Store screenshot upload failed for ${target} during ${name}: ${error.message}`, { cause: error });
  }
}

export async function replaceLocaleScreenshots({ locale, files, dashboard, onProgress = () => {} }) {
  await phase(locale, undefined, "locale selection", () => dashboard.selectLocale(locale));
  let count = await phase(locale, undefined, "screenshot count", () => dashboard.screenshotCount());

  if (count === 4) {
    const recovery = files[0];
    await phase(locale, recovery.variant.file, "interruption recovery upload", () => dashboard.uploadScreenshot(recovery.path));
    await phase(locale, recovery.variant.file, "interruption recovery wait", () => dashboard.waitForScreenshotCount(5));
    onProgress({ locale, variant: recovery.variant.file, phase: "recovered" });
    count = 5;
  }
  if (count !== 5) {
    throw new Error(`Store screenshot upload failed for ${locale} during pre-replacement count: expected 4 or 5 screenshots, found ${count}`);
  }

  for (const file of files) {
    const variant = file.variant.file;
    await phase(locale, variant, "removal", () => dashboard.removeFirstScreenshot());
    await phase(locale, variant, "post-removal wait", () => dashboard.waitForScreenshotCount(4));
    await phase(locale, variant, "upload", () => dashboard.uploadScreenshot(file.path));
    await phase(locale, variant, "post-upload wait", () => dashboard.waitForScreenshotCount(5));
    onProgress({ locale, variant, phase: "uploaded" });
  }

  await phase(locale, undefined, "draft save", () => dashboard.saveDraft());
  onProgress({ locale, phase: "saved" });
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
}
