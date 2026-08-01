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
  // Substitutions for entries whose title/description carries a `$1`-style
  // placeholder (e.g. "Farm drops in every $1 category"). Without these, the
  // search haystack contains the literal placeholder instead of the word the
  // user actually sees, and a query for that word finds nothing.
  titleSubstitution?: string;
  descriptionSubstitution?: string;
}

export interface SettingsGroupNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  titleKey: string;
  advanced?: boolean;
  entries: TEntry[];
}

export interface SettingsSectionNode<TEntry extends SettingsEntryNode = SettingsEntryNode> {
  id: string;
  rows: TEntry[];
  groups: Array<SettingsGroupNode<TEntry>>;
}

export interface FilterOptions {
  t: TranslateFn;
  query: string;
  showAdvanced: boolean;
}

function entryText(entry: SettingsEntryNode, t: TranslateFn): string[] {
  return [t(entry.titleKey, entry.titleSubstitution), t(entry.descriptionKey, entry.descriptionSubstitution)];
}

// An advanced entry is reachable in exactly two situations: the user asked for
// advanced settings, or the user searched for it by name.
function advancedVisible(isAdvanced: boolean, showAdvanced: boolean, searching: boolean): boolean {
  return !isAdvanced || showAdvanced || searching;
}

// Generic over the concrete section type (not just the entry type) so that
// extra properties a caller's section carries — icon, iconNode, whatever a
// future registry adds — survive the round trip. The `{ ...section, ... }`
// construction below already produces exactly this type at runtime; being
// generic over TSection just lets the type system say so, instead of forcing
// every caller to cast the extra properties back in.
export function filterSettingsTree<
  TEntry extends SettingsEntryNode,
  TSection extends SettingsSectionNode<TEntry>,
>(
  sections: ReadonlyArray<TSection>,
  { t, query, showAdvanced }: FilterOptions,
): Array<TSection & { matchCount: number }> {
  const searching = normalizeSearchText(query).length > 0;

  const result: Array<TSection & { matchCount: number }> = [];
  for (const section of sections) {
    let matchCount = 0;

    const keepEntry = (entry: TEntry, groupAdvanced = false): boolean => {
      const isAdvanced = Boolean(entry.advanced ?? groupAdvanced);
      if (!advancedVisible(isAdvanced, showAdvanced, searching)) return false;
      if (!searching) return true;
      return matchesSearch(entryText(entry, t), query);
    };

    const rows = section.rows.filter((row) => {
      const kept = keepEntry(row);
      if (kept && searching) matchCount += 1;
      return kept;
    });

    // Typed off the caller's section so extra group properties (description,
    // badge) survive the filter instead of being erased to the node shape.
    const groups: TSection["groups"] = [];
    for (const group of section.groups) {
      const groupAdvanced = Boolean(group.advanced);
      if (!advancedVisible(groupAdvanced, showAdvanced, searching)) continue;
      // A group-title match keeps the group's entries, so searching "drops"
      // finds the controls in that focused group without reviving a broad
      // General/Twitch/Kick wrapper.
      const groupMatched = searching && matchesSearch([t(group.titleKey)], query);
      const entries = group.entries.filter((entry) => {
        // A group-title match is as specific as an entry match, so it reveals
        // the group's advanced entries without the switch.
        if (groupMatched) return true;
        return keepEntry(entry, groupAdvanced);
      });
      if (entries.length === 0) continue;
      if (searching) matchCount += entries.length;
      groups.push({ ...group, entries });
    }

    if (rows.length === 0 && groups.length === 0) continue;
    result.push({ ...section, rows, groups, matchCount: searching ? matchCount : 0 });
  }

  return result;
}
