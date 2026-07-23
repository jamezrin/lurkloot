# Settings Factory Reset

## Context

Issue #208 asks for a Settings action that restores the browser extension to its defaults. The extension already has a tested `resetStorage()` helper, but nothing exposes it to the popup. The helper currently rewrites settings and scheduler state and clears activity history; it does not clear auxiliary extension-owned keys such as popup preferences, update notices, or cached Twitch integrity data, and it does not coordinate with live farming work.

A factory reset must leave no Lurkloot-owned state or behavior behind. It must not modify Twitch or Kick cookies because those belong to the user's normal browser sessions rather than to Lurkloot.

## Goals

- Add a destructive action at the bottom of the extension Settings view.
- Require an explicit inline confirmation before resetting.
- Stop automation and close every farming or page-context tab managed by Lurkloot.
- Remove all extension-owned local-storage data and activity history.
- Restore canonical, schema-versioned default settings and default scheduler state.
- Update the open popup immediately with the fresh default snapshot.
- Preserve Twitch and Kick login cookies.
- Make failures visible and retryable without claiming the reset succeeded.

## Non-goals

- Logging the user out of Twitch or Kick.
- Clearing site cookies, cache, browsing history, or any other browser-owned data.
- Adding reset behavior to the CLI.
- Resetting browser extension permissions or uninstalling the extension.
- Redesigning the rest of Settings.

## Architecture

The shared runtime-message contract will gain an extension-owned `resetExtension` message. The extension background dispatcher will handle it before delegating ordinary engine messages to the generic controller, following the existing pattern for activity and credential-export messages.

Reset is coordinated in the background in this order:

1. Ask the controller to prepare for a host reset. This aborts in-flight claim handoffs and stops tabless watchers, managed watch tabs, and managed page-context tabs. Reset cleanup always closes extension-managed tabs, independent of the user's `autoCloseFinishedDrops` preference.
2. Clear all values in `browser.storage.local` while holding the existing settings and state mutation locks, then atomically write schema-versioned `DEFAULT_SETTINGS` and `DEFAULT_STATE`.
3. Clear the IndexedDB activity repository.
4. Clear controller-held transient state, including cached Twitch integrity and managed page-context registrations.
5. Return a freshly loaded `RuntimeSnapshot` to the popup.

Browser-specific deletion remains in `packages/extension`. The browser-free controller exposes only the lifecycle operation needed to stop its in-memory and managed resources; it does not know about browser storage, popup preferences, update notices, or cookies. Reset coordination is serialized so concurrent settings or scheduler writes cannot repopulate stale data after the reset.

If activity-store clearing fails after operational storage has reset, the reset request rejects and the popup shows an error. Retrying is safe and idempotent. The canonical defaults remain written, while a retry can finish removing the remaining activity data.

## Popup behavior

The live extension adds a “Reset Lurkloot” danger area at the bottom of Settings. The site demo and store-screenshot modes omit it because their adapters do not expose reset capability.

The first click arms an inline confirmation that explains what will be removed and explicitly says Twitch and Kick accounts remain signed in. The confirmation offers Cancel and Reset buttons. Confirming disables the controls and shows an in-progress label so duplicate requests cannot start.

On success, the popup replaces its local snapshot and settings reference with the returned defaults, clears popup-only view state that may have survived in React memory, closes Settings, and shows the normal paused/default main view. The background storage clear naturally resets persisted popup preferences such as selected platform, collapsed sections, advanced-settings visibility, update notices, and install/rate-nudge timing.

On failure, the popup keeps Settings open, disarms the confirmation, and presents a localized alert with a retryable reset button. It does not replace the current snapshot or claim that data was cleared.

## Data scope

The reset removes every value owned by the extension in `browser.storage.local`, including:

- settings and settings-schema metadata;
- scheduler state and farming progress;
- cached Twitch integrity data;
- selected platform and Settings presentation preferences;
- pending changelog/update-notice state;
- install-date and rate-nudge state stored with settings or scheduler state;
- any legacy or future extension-owned local-storage keys.

After clearing, only canonical default settings and scheduler state are written back. Activity and diagnostic history in IndexedDB are cleared separately. Twitch and Kick cookies are neither read nor written by this flow.

## Localization and accessibility

Every supported locale receives strings for the danger-area title, explanation, initial action, confirmation copy, cancel action, final confirmation, progress state, and failure alert. The confirmation is inline rather than a browser modal, matching the existing activity-clear and credential-export interaction patterns. Buttons remain keyboard reachable, focus rings use existing primitives/styles, the failure message uses `role="alert"`, and destructive styling is reserved for the final confirmed action.

## Testing

Storage tests will verify that reset clears arbitrary and known auxiliary local keys, clears activity data, and leaves only current-schema default settings plus default scheduler state. They will retain concurrency coverage so an in-flight migration or save cannot overwrite the reset. Failure tests will cover activity-store errors and safe retry behavior.

Background tests will start from active Twitch and Kick sessions with managed watch and page-context tabs, including `autoCloseFinishedDrops: false`. They will prove that reset aborts live work, closes extension-managed tabs, clears transient controller state, invokes storage reset once, and returns the default snapshot. They will also prove that cookies are outside the reset path.

Popup tests will verify the two-click confirmation, cancellation, duplicate-request blocking, progress state, immediate default snapshot on success, Settings closure, and retryable error behavior without optimistic data loss. Adapter capability tests will verify that the destructive action appears only in the live extension and is absent from the demo/site rendering.

Locale-catalog validation will ensure every new message exists in every supported catalog. Focused tests will run during development, followed by `pnpm verify` from the isolated worktree.

## Acceptance mapping

The background-only coordinator ensures live automation is stopped before data disappears. Clearing all extension local storage plus activity IndexedDB satisfies “settings + data,” while rewriting canonical defaults gives the popup and future background wakes a valid initial state. The adapter capability boundary hides the action from non-extension hosts. Inline confirmation and explicit failure handling make the destructive operation deliberate and recoverable, and the cookie exclusion preserves normal platform login sessions.
