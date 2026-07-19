const headings = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];

export function releaseNotes(changelog, version, { pending = false } = {}) {
  const entry = changelog.find((item) => item.version === version);
  // A candidate is built before prepare-release writes the entry, so a missing one is expected
  // there and must not block the preview; a real release still requires the written notes.
  if (!entry && pending) return `_No changelog entry for ${version} yet._`;
  if (!entry) throw new Error(`no changelog entry for ${version}`);
  const sections = [];
  for (const [kind, heading] of headings) {
    const lines = entry.changes
      .filter((change) => change.kind === kind)
      .map((change) => `- ${change.text}`);
    if (lines.length > 0) sections.push([`## ${heading}`, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}
