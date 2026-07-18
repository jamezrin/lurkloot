const headings = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];

export function releaseNotes(changelog, version) {
  const entry = changelog.find((item) => item.version === version);
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
