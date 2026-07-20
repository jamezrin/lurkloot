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
