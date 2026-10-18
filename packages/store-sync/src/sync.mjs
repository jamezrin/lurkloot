import { hashFiles, isUnchanged } from "./syncState.mjs";

// Every failure names where it happened and what to rerun, because a sync can
// stop halfway and the person reading the error has to finish it.
async function phase(context, scope, variant, name, action) {
  try {
    return await action();
  } catch (error) {
    const target = variant ? `${scope}/${variant}` : scope;
    throw new Error(
      `Store listing sync failed for ${target} during ${name}: ${error.message}. ${context.retryHint(scope)}`,
      { cause: error },
    );
  }
}

export function createContext({ command = "store-sync" } = {}) {
  return {
    command,
    retryHint: (scope) =>
      scope === "global"
        ? `Retry with: ${command} --only global`
        : `Retry with: ${command} --locales ${scope}`,
  };
}

export async function setLocaleDescription({
  context,
  locale,
  description,
  dashboard,
  onProgress = () => {},
}) {
  await phase(context, locale, undefined, "locale selection", () => dashboard.selectLocale(locale));
  const changed = await phase(context, locale, undefined, "description edit", () =>
    dashboard.setDescription(description),
  );
  if (!changed) {
    onProgress({ locale, phase: "description-unchanged" });
    return;
  }
  await phase(context, locale, undefined, "description save", () => dashboard.saveDraft());
  onProgress({ locale, phase: "description-saved" });
}

// Makes one screenshot group hold exactly `files`, in order. The dashboard only
// offers "remove the leading image" and "add one", so the group is trimmed to
// size, topped up, and then rotated once: each image is removed from the front
// and its replacement appended, which leaves the new set in the new order.
export async function replaceScreenshots({
  context,
  scope,
  files,
  dashboard,
  section = scope === "global" ? "global" : "localized",
  onProgress = () => {},
}) {
  if (section === "localized") {
    await phase(context, scope, undefined, "locale selection", () => dashboard.selectLocale(scope));
  }
  // An empty localized panel is located differently from a populated one, so
  // the check is repeated for every group rather than trusted from preflight.
  await phase(context, scope, undefined, "section check", () =>
    dashboard.requireDistinctScreenshotSections(),
  );
  const wanted = files.length;
  const initialCount = await phase(context, scope, undefined, "screenshot count", () =>
    dashboard.screenshotCount(section),
  );

  let count = initialCount;
  while (count > wanted) {
    await phase(context, scope, undefined, "trim", () => dashboard.removeFirstScreenshot(section));
    await phase(context, scope, undefined, "trim wait", () =>
      dashboard.waitForScreenshotCount(count - 1, section),
    );
    count -= 1;
  }
  const kept = count;

  // A new group starts empty and an interrupted run can leave one short, so the
  // group is topped up before the rotation needs a full one.
  for (const file of files.slice(0, wanted - kept)) {
    await phase(context, scope, file.name, "fill upload", () =>
      dashboard.uploadScreenshot(file.path, section),
    );
    await phase(context, scope, file.name, "fill wait", () =>
      dashboard.waitForScreenshotCount(count + 1, section),
    );
    count += 1;
    onProgress({
      locale: scope,
      variant: file.name,
      phase: initialCount === 0 ? "uploaded" : "recovered",
      section,
    });
  }

  // Filling an empty group already produced the desired order.
  if (kept > 0) {
    for (const file of files) {
      await phase(context, scope, file.name, "removal", () =>
        dashboard.removeFirstScreenshot(section),
      );
      await phase(context, scope, file.name, "post-removal wait", () =>
        dashboard.waitForScreenshotCount(wanted - 1, section),
      );
      await phase(context, scope, file.name, "upload", () =>
        dashboard.uploadScreenshot(file.path, section),
      );
      await phase(context, scope, file.name, "post-upload wait", () =>
        dashboard.waitForScreenshotCount(wanted, section),
      );
      onProgress({ locale: scope, variant: file.name, phase: "uploaded", section });
    }
  }

  await phase(context, scope, undefined, "draft save", () => dashboard.saveDraft());
  onProgress({ locale: scope, phase: "saved", section });
}

// True when this group holds exactly what the last verified sync left there:
// the same local files, and the same thumbnails on the dashboard now.
async function unchangedSinceLastSync({ context, scope, files, dashboard, previousState, force }) {
  if (force || !previousState) return false;
  const entry = previousState.scopes[scope];
  if (!entry) return false;
  const section = scope === "global" ? "global" : "localized";
  if (section === "localized") {
    await phase(context, scope, undefined, "locale selection", () => dashboard.selectLocale(scope));
  }
  const liveIds = await phase(context, scope, undefined, "thumbnail read", () =>
    dashboard.thumbnailIds(section),
  );
  return isUnchanged({
    entry,
    hashes: await hashFiles(files),
    liveIds,
    expectedCount: files.length,
  });
}

export async function syncStoreListing({
  bundle,
  locales,
  parts,
  dashboard,
  context = createContext(),
  previousState,
  force = false,
  onProgress = () => {},
}) {
  try {
    await dashboard.preflight({
      locales: locales.length > 0 ? locales : bundle.locales.slice(0, 1),
      screenshots: parts.screenshots || parts.global,
      descriptions: parts.descriptions,
    });
  } catch (error) {
    throw new Error(`Store listing sync failed during dashboard preflight: ${error.message}`, {
      cause: error,
    });
  }

  const syncScreenshots = async (scope, files) => {
    const args = { context, scope, files, dashboard, previousState, force };
    if (await unchangedSinceLastSync(args)) {
      onProgress({ locale: scope, phase: "screenshots-unchanged" });
      return;
    }
    await replaceScreenshots({ context, scope, files, dashboard, onProgress });
  };

  for (const locale of locales) {
    const scope = bundle.scope(locale);
    if (parts.descriptions && scope?.description) {
      await setLocaleDescription({
        context,
        locale,
        description: scope.description.text,
        dashboard,
        onProgress,
      });
    }
    if (parts.screenshots && scope?.screenshots) await syncScreenshots(locale, scope.screenshots);
  }
  if (parts.global) await syncScreenshots("global", bundle.global.screenshots);
}
