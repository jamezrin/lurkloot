# Per-Platform Automation Presentation Design

## Problem

The popup currently derives an automation card from multiple independent
sources. The toggle uses pending or persisted settings, the badge primarily
uses authentication health, and the detail may use the scheduler session's
raw English message. These sources can advance at different times and produce
contradictory combinations such as:

- `Starting automation...` followed by `Starting automation`
- a `Running` badge paired with `Automation disabled`

Twitch and Kick also transition independently, so the presentation must not
infer one platform's state from the other.

## Design

The popup will build one canonical `AutomationPresentation` for each platform.
The presentation will be the only source for the automation card's badge,
detail, tone, operational styling, action, and transition status.

The canonical lifecycle states are:

- `paused`
- `starting`
- `running`
- `stopping`
- `checking`
- `needs_sign_in`
- `blocked`
- `unavailable`
- `paused_tab_closed`

The presentation resolver will receive the platform's effective enabled
setting, local pending transition, authentication health, scheduler session,
and manual-close pause state. It will rank those inputs explicitly:

1. A local stop transition is `stopping`.
2. A local start transition, or an enabled session carrying the controller's
   startup marker, is `starting`.
3. A disabled platform is `paused`.
4. A manual-close pause is `paused_tab_closed`.
5. Authentication problems map to their existing user-actionable states.
6. A healthy enabled platform is `running`.

Both badge and detail will come from the selected presentation state. Raw
`session.message` may supply the running detail only when it is compatible
with an enabled, settled session. Transitional or contradictory scheduler
messages such as `Starting automation` and `Automation disabled` will never be
rendered as running detail.

Scheduler messages remain English diagnostic/state data. This change will not
localize them or add diagnostic locale keys. User-facing transition copy will
continue to use locale catalog keys.

## Platform Isolation

The popup will resolve Twitch and Kick separately from their respective
settings, auth health, session, and pending transition. Starting or stopping
one platform must not alter the other platform's presentation.

## Consistency Invariants

- `starting` always renders the `Starting` badge and localized
  `Starting automation...` detail.
- `running` never renders `Automation disabled`, `Platform disabled`, or
  `Starting automation` as its detail.
- A checked toggle cannot render a `paused` presentation unless the user is in
  an explicit manual-close pause state.
- An unchecked toggle cannot render `running`.
- Badge, detail, styling, and actions always come from the same presentation.

## Testing

Focused popup presentation tests will cover:

- the local pending start state;
- the persisted startup marker after the runtime request completes;
- stale `Automation disabled` session data with enabled settings and healthy
  authentication;
- normal settled running detail;
- independent Twitch and Kick presentations;
- existing authentication and manual-close states.

The implementation will then run the full repository verification suite and
rebuild the Chromium extension for manual testing.
