# Popup Authentication Health Design

## Context

The popup currently derives its Running presentation from the global and per-platform automation settings. That can label an enabled platform as Running or Farming while its account-dependent work is suspended because authentication is being checked, credentials are absent or rejected, Kick has rejected the browser profile, or the platform is temporarily unavailable.

The scheduler already exposes a normalized `PlatformAuthHealth` for Twitch and Kick in `RuntimeSnapshot.state.authHealth`. Cookie changes trigger a platform-only authentication recheck and publish a fresh snapshot, so this work only needs to present that existing state safely and reactively. It must not change the user's automation setting or expose credential or response content.

## Goals

- Make the selected platform's hero accurately distinguish Running, Checking, Needs sign-in, Blocked, Unavailable, and Paused.
- Show Running only when automation is enabled and authentication is healthy.
- Give missing or rejected credentials an explicit platform-specific sign-in action.
- Explain Kick security-policy blocking without implying that signing in is sufficient.
- Keep the automation toggle available in every degraded authentication state.
- Update naturally when a fresh runtime snapshot reports authentication recovery.
- Localize all new user-facing copy in every catalog.

## Non-goals

- Changing authentication probes, scheduler blocking, cookie observation, or retry behavior.
- Adding credential entry, storage, or rendering to the popup.
- Adding manual authentication recheck controls.
- Changing the CLI authentication experience.

## Approach

Add a pure popup presentation function that maps automation state, toggle-pending state, platform, and `PlatformAuthHealth` to a small view model. The view model owns the badge label key, visual tone, explanatory message key, and optional action. `AutomationHero` renders this model while remaining responsible for layout and toggle interaction.

This keeps authentication policy out of JSX, provides one exhaustive mapping for all shared health statuses, and allows focused deterministic tests. Handling the statuses inline in `AutomationHero` would save a small file but couple rendering and policy. A separate warning card would duplicate status information and leave the hero badge misleading, so neither alternative is preferred.

## State Mapping

State priority is:

1. A pending toggle operation shows the existing Starting or Stopping state.
2. Disabled automation shows Paused, independent of retained authentication health.
3. Enabled automation maps authentication health as follows:
   - `healthy`: Running, with the existing watching/farming or waiting detail.
   - `checking`: Checking, with neutral progress copy.
   - `missing_credentials`: Needs sign-in, with an explicit Sign in to Twitch or Sign in to Kick action.
   - `invalid_credentials`: Needs sign-in, with rejected-session copy and the same platform-specific action.
   - `blocked`: Blocked, with copy explaining that Kick rejected this browser profile and that signing in alone may not resolve it. No sign-in action is shown.
   - `unavailable`: Unavailable, with reason-specific safe copy for credential lookup, platform, or network failure. No sign-in action is shown.

Unknown or absent persisted health is already normalized to `checking` by the shared state boundary.

## UI Behavior

The existing automation hero remains the single status surface. Its badge tone follows the derived presentation rather than the enabled flag: accent for Running, muted for Paused or Checking, warning for Needs sign-in or Unavailable, and danger for Blocked. The hero glow and power icon should likewise avoid presenting degraded states as healthy.

For missing or rejected credentials, a compact explicit button appears alongside the explanatory copy. It opens the selected platform's HTTPS sign-in page through the existing popup adapter and HTTPS boundary helper. The action is a real button with a localized accessible label. Twitch and Kick use fixed first-party sign-in URLs; runtime state never supplies the destination.

The automation toggle remains enabled unless an automation setting change is already pending. Clicking it in a degraded state changes automation exactly as it does today.

The header summary and platform-switcher indicator must use the same derived operational presentation so they do not continue to claim Active or show a healthy dot while the hero is degraded.

## Data Flow and Recovery

`Popup` reads `snapshot.state.authHealth[platform]` and derives the presentation for the selected platform. It passes that presentation to the header, platform switcher, and automation hero. Existing snapshot updates replace the health value. When cookie-triggered recovery changes the status from degraded to healthy, React recomputes the presentation and returns the UI to Running without toggling automation or adding a popup polling loop.

Preview/demo snapshots continue to provide explicit health values and therefore exercise the same rendering path.

## Safety and Error Handling

Only the normalized status, reason code, and allowlisted localized message key influence rendering. Credentials, raw errors, and authenticated response bodies are never accepted by the presentation model or rendered. Optional safe message values such as an opaque reference are not required in the popup copy and will not be displayed.

External actions use hard-coded HTTPS destinations and the existing validated link-opening boundary. Temporarily unavailable states do not claim a fix; they explain that Lurkloot will retry automatically.

## Localization

Add keys for the five enabled-state badge labels, missing-credential and rejected-credential explanations, the two explicit sign-in button labels, Kick browser-profile rejection guidance, and temporary failure explanations. Every catalog receives the complete key set, and catalog parity remains enforced by the existing i18n tests.

## Testing

Add focused popup component and presentation tests that cover:

- Paused and pending-operation precedence.
- Healthy, checking, missing, invalid, blocked, and each unavailable reason.
- Running appearing only for enabled plus healthy.
- Twitch and Kick sign-in button labels and fixed HTTPS destinations.
- No sign-in action for blocked or unavailable states.
- The toggle remaining enabled throughout degraded states.
- Safe omission of message values and any unrelated data.
- Rerendering from a degraded snapshot to healthy after the adapter publishes recovery, without changing automation settings.
- Header and platform-switcher indicators agreeing with the hero.
- Complete locale key parity.

Run the focused tests during development, then `pnpm check` and the relevant extension build verification before completion.
