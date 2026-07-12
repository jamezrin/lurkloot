import { browser } from "wxt/browser";
import { CHANGELOG_URL } from "./links";

const PENDING_CHANGELOG_VERSION_KEY = "pendingChangelogVersion";

export async function loadPendingChangelogVersion(): Promise<string | undefined> {
  const stored = await browser.storage.local.get(PENDING_CHANGELOG_VERSION_KEY);
  return typeof stored[PENDING_CHANGELOG_VERSION_KEY] === "string"
    ? stored[PENDING_CHANGELOG_VERSION_KEY]
    : undefined;
}

export async function savePendingChangelogVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [PENDING_CHANGELOG_VERSION_KEY]: version });
}

export async function dismissPendingChangelogVersion(): Promise<void> {
  await browser.storage.local.remove(PENDING_CHANGELOG_VERSION_KEY);
}

export function changelogUrl(version: string): string {
  return `${CHANGELOG_URL}#v${version}`;
}
