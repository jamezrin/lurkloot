# Apply Settings Without Pausing Automation

## Context

Opening the popup Settings view currently opens a dedicated runtime port. The background controller treats that connection as a temporary global pause: it aborts post-claim handoffs, runs the scheduler with `running: false`, stops managed farming and page-context tabs, and suppresses tabless heartbeats. Disconnecting the port triggers another global scheduler cycle to rebuild automation. The popup then polls until the temporary disabled session state disappears.

Settings already save automatically. Visiting the view should not alter automation state; only a setting whose value changes should cause work, and that work should be scoped to the affected platforms where possible.

## Goals

- Opening and closing Settings leaves active Twitch and Kick farming untouched.
- Auto-saved changes remain serialized and cannot overwrite newer changes.
- Scheduling changes reconcile promptly: global changes refresh all enabled platforms, while platform-specific changes refresh only that platform.
- Explicitly disabling automation or a provider continues to stop it immediately.
- Rapid edits do not start overlapping scheduler state mutations.

## Non-goals

- Debouncing or batching setting changes beyond the existing serialized save queue.
- Moving refresh classification into the browser-free controller.
- Changing the settings schema, storage format, scheduler algorithm, or CLI behavior.
- Redesigning the Settings UI.

## Design

### Remove the settings-session lifecycle

The popup will no longer connect a Settings-specific runtime port. The extension background will no longer listen for that port, and the shared port constant and popup adapter hook will be removed.

The controller will remove `settingsPauseCount`, `beginSettingsSession`, `endSettingsSession`, and forced-paused scheduler ticks. Normal scheduler ticks and tabless heartbeats will consult only persisted automation settings. Post-claim handoffs will no longer abort merely because Settings opened.

The popup will remove its close-time resume polling, `resumingAutomation` state, and the temporary-disabled-session detection used only by that workaround. Opening or closing Settings becomes a UI-only state transition.

### Apply setting changes by impact

`saveSettings` retains its existing optional reconciliation request. Refresh intent remains explicit at the UI control that owns the change, keeping the generic controller independent of extension-only settings.

Global scheduling changes request an immediate reconciliation of all enabled platforms:

- campaign priority mode and priority ordering;
- campaign visibility, excluded-campaign changes, and Idle Watchlist fallback policy;
- tabless mode;
- skip-unfinishable-rewards and deadline safety margin.

Platform scheduling changes request an immediate reconciliation only for the affected platform:

- farm-all-categories and category allowlists;
- excluded channels;
- idle-watchlist ordering.

Other settings save without a scheduler tick. This includes appearance, startup preference, notifications, auto-claim policy, playback policy, scheduler interval, handoff tuning, diagnostics, and compatibility selection. The scheduler interval still recreates its alarm during the save, as it does today. Runtime consumers read the remaining policies at their existing boundaries.

Automation toggles remain separate from ordinary settings saves. `setAutomation` continues to persist the platform state and run the scheduler immediately, so disabling a provider stops it without waiting for an alarm.

### Serialization and errors

The popup's `settingsSaveQueue` continues to serialize optimistic setting patches and background requests. A failed request does not poison later saves because each queued operation recovers the preceding rejection before starting. The controller's settings lock serializes load-modify-save operations, and its state lock serializes scheduler mutations, so rapid changes cannot lose updates or overlap state reconciliation.

No paused fallback state is introduced when saving or reconciliation fails. The individual request rejects under the existing behavior, while later queued edits remain able to proceed.

## Testing

Controller tests will replace the temporary-settings-pause expectations with coverage that opening Settings has no controller lifecycle at all. Existing save tests will continue to prove patch merging, alarm recreation, global ticks, targeted ticks, and paused-automation behavior. Handoff coverage will confirm that an ordinary settings save preserves an active handoff, while explicit automation shutdown still aborts it. A gated rapid-edit regression will prove that every patch is preserved and reconciliation calls remain serialized.

Popup and settings tests will verify:

- opening and closing Settings does not create a background pause/resume connection or close-time polling cycle;
- global scheduling controls request a global post-save tick;
- platform controls request a post-save tick scoped to their platform;
- save-only controls do not request reconciliation;
- serialized rapid changes preserve all patches without overlapping reconciliation.

Focused tests will run during development. Final verification is `pnpm verify` from the isolated worktree.

## Acceptance mapping

Removing the port and controller pause lifecycle ensures Settings cannot produce `Automation disabled`, stop tabs, or require a resume cycle. Explicit reconciliation flags make scheduling changes prompt and scoped. Existing save and state locks preserve ordering, and `setAutomation` retains immediate shutdown behavior.
