// Search over settings text. Kept free of React and of the catalog loader so it
// can be unit-tested directly: callers resolve their own strings first.

// Diacritics are folded so a Spanish or French user can type without accents and
// still hit their own localized labels.
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// Every whitespace-separated token in the query must appear somewhere across the
// supplied strings. Order does not matter, and a token may match the title while
// another matches the description.
export function matchesSearch(haystacks: readonly string[], query: string): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const hay = haystacks.map(normalizeSearchText).join(" ");
  return needle.split(/\s+/).every((token) => hay.includes(token));
}

export type TranslateFn = (key: string, substitution?: string) => string;

// The filter only needs the searchable skeleton of the registry. The real
// registry entries carry a render function too; extra properties ride along
// untouched, which is why the node types are generic over the concrete entry.
export interface SettingsEntryNode {
  id: string;
  titleKey: string;
  descriptionKey: string;
  advanced?: boolean;
}

export interface SettingsGroupNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  titleKey: string;
  advanced?: boolean;
  entries: TEntry[];
}

export interface SettingsSectionNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  titleKey: string;
  rows: TEntry[];
  groups: Array<SettingsGroupNode<TEntry>>;
}

export interface FilteredSection<TEntry extends SettingsEntryNode = SettingsEntryNode>
  extends SettingsSectionNode<TEntry> {
  // Zero when there is no active query. Only meaningful while searching.
  matchCount: number;
}

export interface FilterOptions {
  t: TranslateFn;
  query: string;
  showAdvanced: boolean;
}

function entryText(entry: SettingsEntryNode, t: TranslateFn): string[] {
  return [t(entry.titleKey), t(entry.descriptionKey)];
}

// An advanced entry is reachable in exactly two situations: the user asked for
// advanced settings, or the user searched for it by name.
function advancedVisible(isAdvanced: boolean, showAdvanced: boolean, searching: boolean): boolean {
  return !isAdvanced || showAdvanced || searching;
}

export function filterSettingsTree<TEntry extends SettingsEntryNode>(
  sections: ReadonlyArray<SettingsSectionNode<TEntry>>,
  { t, query, showAdvanced }: FilterOptions,
): Array<FilteredSection<TEntry>> {
  const searching = normalizeSearchText(query).length > 0;

  const result: Array<FilteredSection<TEntry>> = [];
  for (const section of sections) {
    // A section title match keeps the whole section, so "twitch" surfaces
    // everything Twitch-related rather than only rows containing the word.
    const sectionMatched = searching && matchesSearch([t(section.titleKey)], query);
    let matchCount = 0;

    const keepEntry = (entry: TEntry, groupAdvanced = false): boolean => {
      const isAdvanced = Boolean(entry.advanced ?? groupAdvanced);
      if (!advancedVisible(isAdvanced, showAdvanced, searching)) return false;
      if (!searching) return true;
      // Under a section-title match, advanced content still obeys the switch.
      if (sectionMatched) return !isAdvanced || showAdvanced;
      return matchesSearch(entryText(entry, t), query);
    };

    const rows = section.rows.filter((row) => {
      const kept = keepEntry(row);
      if (kept && searching && !sectionMatched) matchCount += 1;
      return kept;
    });

    const groups: Array<SettingsGroupNode<TEntry>> = [];
    for (const group of section.groups) {
      const groupAdvanced = Boolean(group.advanced);
      if (!advancedVisible(groupAdvanced, showAdvanced, searching)) continue;
      // A group-title match keeps the group's entries, same reasoning as sections.
      const groupMatched = searching && !sectionMatched && matchesSearch([t(group.titleKey)], query);
      const entries = group.entries.filter((entry) => {
        // A group-title match is as specific as an entry match, so it reveals
        // the group's advanced entries without the switch. A section-title
        // match is broad and deliberately does not — see keepEntry.
        if (groupMatched) return true;
        return keepEntry(entry, groupAdvanced);
      });
      if (entries.length === 0) continue;
      if (searching && !sectionMatched) matchCount += entries.length;
      groups.push({ ...group, entries });
    }

    if (rows.length === 0 && groups.length === 0) continue;
    result.push({ ...section, rows, groups, matchCount: searching ? matchCount : 0 });
  }

  return result;
}
