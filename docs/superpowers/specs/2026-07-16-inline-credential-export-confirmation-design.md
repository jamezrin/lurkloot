# Inline Credential Export Confirmation Design

## Context

Issue #97 reports that exporting CLI credentials opens a browser-native confirmation dialog whose content overflows the extension popup. The settings view currently calls `window.confirm` with a localized security warning before invoking the existing credential export callback. Browser-native dialogs cannot be sized or styled to fit the popup.

## Goal

Replace the browser-native confirmation with an accessible inline confirmation that stays within the popup layout while preserving an explicit security acknowledgment before credentials are exported.

## Interaction Design

The Headless CLI settings section initially keeps its current hint and **Export credentials** action. Selecting that action arms the export and replaces the normal action row with:

- the existing localized credential-security warning;
- a **Cancel** button; and
- a **Confirm export** button.

Selecting **Cancel** restores the initial action without exporting. Selecting **Confirm export** clears the armed state and invokes `onExportCredentials` exactly once. There is no timeout. Leaving Settings unmounts `SettingsView`, so its local armed state is discarded automatically; returning to Settings shows the initial action.

The confirmation is inline rather than a custom modal or separate screen. This avoids popup overlay and focus-trapping complexity, keeps the warning beside the affected setting, and follows the popup's existing two-step destructive-action language.

## Component and State Changes

`SettingsView` owns a local `exportArmed` boolean initialized to `false`. The state is only relevant when the optional `onExportCredentials` callback exists.

The existing `window.confirm` call is removed. The initial button only sets `exportArmed` to `true`. The armed UI provides explicit handlers:

- cancel: set `exportArmed` to `false`;
- confirm: set `exportArmed` to `false`, then invoke `onExportCredentials` without awaiting it, matching the current callback contract.

Credential collection, serialization, download behavior, and the `onExportCredentials` interface remain unchanged. No new component library or runtime dependency is introduced.

## Localization

Reuse `cliExportConfirm` for the inline warning. Add two message keys to every locale catalog:

- `cliExportCancel` for the cancel action;
- `cliExportConfirmButton` for the final confirmation action.

English source copy is **Cancel** and **Confirm export**. Each existing catalog receives an appropriate translation so catalogs remain structurally synchronized.

## Accessibility and Layout

The warning must wrap within the settings card and use the popup's existing small-text styling. The action buttons may wrap on narrow widths rather than forcing horizontal overflow. Both controls are native `button` elements with `type="button"`, visible text, keyboard activation, and existing focus-visible styling conventions.

The armed region should expose the warning as ordinary visible content; it does not need modal semantics because it neither traps focus nor blocks the rest of Settings.

## Error Handling

This change does not add export-result UI. The armed state clears immediately when confirmation is selected, even if the asynchronous export later rejects, preserving the existing fire-and-forget behavior and preventing accidental repeated confirmation clicks. Export error reporting remains outside issue #97's scope.

## Testing

Add a focused React/Vitest settings-view test that mounts `SettingsView` with a mocked `onExportCredentials` callback and verifies:

1. The initial export action is visible and the confirmation controls are absent.
2. Selecting **Export credentials** shows the warning plus Cancel and Confirm export actions without invoking the callback.
3. Selecting **Cancel** restores the initial state without invoking the callback.
4. Re-arming and selecting **Confirm export** invokes the callback exactly once and restores the initial state.
5. Unmounting while armed and remounting starts unarmed, representing navigation away from and back to Settings.
6. The interaction does not call `window.confirm`.

Run the focused test first, then the full extension test suite and workspace typecheck.

## Out of Scope

- Changing the exported credential format or download implementation.
- Adding success, failure, or toast notifications for the export.
- Introducing a reusable modal system.
- Changing the separate activity-history confirmation flow.
