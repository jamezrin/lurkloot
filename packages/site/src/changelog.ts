import changelogData from "./changelog.json" with { type: "json" };

export type ChangeKind = "new" | "improved" | "fixed";

export interface Change {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  changes: Change[];
}

const changeKinds = new Set<ChangeKind>(["new", "improved", "fixed"]);

function isChangeKind(kind: string): kind is ChangeKind {
  return changeKinds.has(kind as ChangeKind);
}

export const changelog: ChangelogEntry[] = changelogData.map((entry) => ({
  ...entry,
  changes: entry.changes.map((change) => {
    if (!isChangeKind(change.kind)) {
      throw new Error(`Unknown changelog change kind: ${change.kind}`);
    }
    return { ...change, kind: change.kind };
  }),
}));
