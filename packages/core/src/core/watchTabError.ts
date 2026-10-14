import type { SafeFetchFailure } from "./fetchError";

// The host's WatchTabPort throws this when a watch tab shows something other
// than the channel page, such as Kick's security-policy JSON (#794). It is not
// an authentication failure: the auth probe takes a different route and would
// report healthy again on the next tick, reopening the tab every minute. The
// scheduler backs the platform off instead, and counts a tab it had to open as
// churn.
export class UnusableWatchTabError extends Error {
  readonly failure: SafeFetchFailure;
  readonly tabId: number;
  readonly openedManagedTab: boolean;

  constructor(tabId: number, failure: SafeFetchFailure, options: { openedManagedTab: boolean }) {
    const detail = [
      failure.reason,
      failure.reference === undefined ? undefined : `reference ${failure.reference}`,
    ].filter(Boolean).join(", ");
    super(`Watch tab ${tabId} did not show the channel page${detail ? ` (${detail})` : ""}`);
    this.name = "UnusableWatchTabError";
    this.failure = failure;
    this.tabId = tabId;
    this.openedManagedTab = options.openedManagedTab;
  }
}
