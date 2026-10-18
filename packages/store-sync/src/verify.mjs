// Reads the dashboard back and compares it with what was meant to be there. A
// sync can finish without an error while the page still shows something else,
// so this is what turns "no error" into "correct".

export function normalizeDescription(text) {
  return text.replace(/\r\n?/g, "\n").trim();
}

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function checkGroup(name, found, expected) {
  const problems = [];
  if (found.length !== expected) {
    problems.push(
      `expected ${plural(expected, "screenshot")} in the ${name} group, found ${found.length}`,
    );
  }
  if (new Set(found).size !== found.length) {
    problems.push(`the ${name} group shows the same image more than once`);
  }
  return problems;
}

// What one language should look like. A language the bundle gives no
// screenshots to is not checked for them: its group may be empty because its
// artwork lives in the shared group.
export function checkLocaleState({ state, expectedDescription, expectedScreenshots }) {
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
    problems.push(...checkGroup("localized", state.localized, expectedScreenshots));
  }
  return problems;
}

export async function verifyStoreListing({
  bundle,
  locales,
  parts,
  dashboard,
  onProgress = () => {},
}) {
  await dashboard.reload();
  const results = [];
  let global;
  for (const locale of locales) {
    const scope = bundle.scope(locale);
    const state = await dashboard.readLocaleState(locale);
    global ??= state.global;
    const problems = checkLocaleState({
      state,
      expectedDescription: parts.descriptions ? scope?.description?.text : undefined,
      expectedScreenshots: parts.screenshots ? scope?.screenshots?.length : undefined,
    });
    results.push({ scope: locale, state, problems });
    onProgress({ scope: locale, problems });
  }
  if (parts.global) {
    // The shared group does not follow the language selector, so any language
    // will show it; one is read only when the run named none.
    if (!global) global = (await dashboard.readLocaleState(bundle.locales[0])).global;
    const problems = checkGroup("global", global, bundle.global.screenshots.length);
    results.push({ scope: "global", state: { global }, problems });
    onProgress({ scope: "global", problems });
  }
  return { ok: results.every(({ problems }) => problems.length === 0), results };
}

export function describeVerification({ results }) {
  return results
    .filter(({ problems }) => problems.length > 0)
    .map(({ scope, problems }) => `${scope}: ${problems.join("; ")}`)
    .join("\n  - ");
}
