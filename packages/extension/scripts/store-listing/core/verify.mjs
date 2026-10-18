// Reads the dashboard back and compares it with what was meant to be there. A
// sync can finish without an error while the page still shows something else,
// so this is what turns "no error" into "correct".

export function normalizeDescription(text) {
  return text.replace(/\r\n?/g, "\n").trim();
}

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

// What one language should look like. The source language's own artwork lives
// in the shared group, so its localized group is reported but not required.
export function checkLocaleState({ listing, state, expectedScreenshots, expectedDescription }) {
  const problems = [];
  if (expectedDescription !== undefined) {
    const found = normalizeDescription(state.description);
    if (found !== normalizeDescription(expectedDescription)) {
      problems.push(
        `description differs from the local file (${found.length} characters on the dashboard)`,
      );
    }
  }
  if (expectedScreenshots !== undefined) {
    const isSource = state.locale === listing.globalScreenshotsFrom;
    const group = isSource ? "global" : "localized";
    const found = isSource ? state.global : state.localized;
    if (found.length !== expectedScreenshots) {
      problems.push(
        `expected ${plural(expectedScreenshots, "screenshot")} in the ${group} group, found ${found.length}`,
      );
    }
    if (new Set(found).size !== found.length) {
      problems.push(`the ${group} group shows the same image more than once`);
    }
  }
  return problems;
}

export async function verifyStoreListing({
  listing,
  locales,
  descriptionsByLocale,
  expectedScreenshots,
  dashboard,
  onProgress = () => {},
}) {
  await dashboard.reload();
  const results = [];
  for (const locale of locales) {
    const state = await dashboard.readLocaleState(locale);
    const problems = checkLocaleState({
      listing,
      state,
      expectedScreenshots,
      expectedDescription: descriptionsByLocale?.get(locale),
    });
    results.push({ locale, state, problems });
    onProgress({ locale, problems });
  }
  return { ok: results.every(({ problems }) => problems.length === 0), results };
}

export function describeVerification({ results }) {
  const failed = results.filter(({ problems }) => problems.length > 0);
  return failed.map(({ locale, problems }) => `${locale}: ${problems.join("; ")}`).join("\n  - ");
}
