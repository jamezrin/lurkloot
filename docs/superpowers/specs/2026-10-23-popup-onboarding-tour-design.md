# Popup Onboarding Tour — Design

## Intent

A new user who installs LurkLoot opens the popup and sees a dense tool: a rail
of views, two platforms, a ranked queue with pins and strategies, games modes,
a watchlist, Twitch extensions and a long Settings view. Nothing tells them how
the pieces fit. The tour walks them through the main use cases once, on demo
data, so every step has something real-looking to point at even before they
are signed in or anything has loaded.

It is a guided spotlight tour, the pattern most apps use: the popup is dimmed
by a semi-transparent scrim, the element the step is about shows through a
cut-out, and a message box beside it explains it.

## Goals

- Shown once, automatically, to **fresh installs only**.
- Shown again (as if new) after the user **resets LurkLoot** from Settings.
- Starts with a welcome card offering **Show me around** or **Skip**.
- Step based; the user advances **only by clicking** (no timers, no auto-advance).
- The tour **switches views and platform itself** for each step.
- While open, the underlying popup is **not interactive** (no clicks, no
  keyboard focus); only the tour's own controls work.
- Runs entirely on **demo data** (`createDemoPopupAdapter` / `demo.ts`, the same
  data the landing site uses).
- Skippable at every step.

## Non-goals

- No replay button anywhere (Settings, About, rail). The only way to see it
  again is a reset.
- Not shown to users upgrading from an earlier version.
- Not shown on the landing site demo, store screenshots, or the in-page panel.
- No diagnostics step or callout. The Activity view's diagnostics toggle simply
  remains visible as part of the normal view.
- No interactive "try it yourself" steps.

## Anti-goals

- The tour must never write to the user's real settings or state. Anything the
  demo popup does during the tour goes to the demo adapter.
- It must not stop or pause real farming. The background keeps running; only
  what the popup displays is swapped.
- It must not leave the popup on demo data after it closes, or flash real
  data mid-tour.
- Not a wall of text: one short message per step.

## Who sees it, and when

A single storage flag, owned by the extension background, mirroring the
existing pending-changelog-notice pattern (`src/core/updateNotice.ts`):

- `runtime.onInstalled` with `reason === "install"` sets the flag. `update`,
  `chrome_update` etc. never set it.
- `resetExtension` in `background.ts` sets the flag after `resetStorage()`
  (which clears `storage.local`), so a reset re-arms the tour.
- `PopupAdapter` gains optional hooks, e.g. `getPendingOnboarding?()` and
  `dismissPendingOnboarding?()`. The toolbar popup implements them; the demo
  adapter, site, screenshots and the in-page panel adapter omit them, which
  keeps the tour out of those hosts (same reasoning as the changelog hooks).
- Finishing (**Done**) or skipping (welcome **Skip**, per-step **Skip**,
  Escape) dismisses the flag. Closing the popup mid-tour does **not** dismiss
  it; the tour starts again from the welcome card next time. *(Builder's call;
  see "Left to the builder".)*
- After a reset from Settings, the popup should show the welcome card
  immediately, without the user closing and reopening the popup.

Do not store this in `ExtensionSettings`: settings are exported/imported and
shared with the CLI, and "absent means done for upgraders, pending for new
installs" does not fit the settings normalization model.

## The steps

Welcome card first, then 12 steps, then a done card. Every step shows a
progress counter (e.g. `3 / 12`), **Back**, **Next** and **Skip**. Step 1 has
no Back; the last step's Next reads **Done** (or leads to the done card).

**Welcome card** (centred over the dimmed popup, no cut-out)
"Welcome to LurkLoot" — one line: it farms Twitch and Kick drops for you in
the background. Buttons: **Show me around** / **Skip**.

Twitch:

1. **Status strip** — what is being farmed, on which channel, and the on/off
   toggle. Always visible from every view.
2. **Platform switch** (rail) — Twitch and Kick each have their own queue,
   games and watchlist.
3. **Queue order** (Queue view, the grouped list) — Pinned → Favourite games →
   "Then by" strategy → Unlinked, farmed last.
4. **Changing the order** (a campaign row's pin control and the "Then by"
   dropdown) — pin and drag pins to reorder; Ending soonest vs Lowest
   availability; excluding a campaign moves it to Skipped, where it can be put
   back.
5. **Completed** (Completed view) — Finished: every reward claimed. Expired:
   ended before it was finished.
6. **Games** (Games view, mode toggle) — All farms every game except blocked
   ones; Include farms only the games you tick; star to favour, block to never
   farm.
7. **Idle Watchlist** (Watchlist view) — channels watched when no drops are
   available, earning channel points that are claimed automatically; their
   order relative to drops is set by watch-source priority.
8. **Twitch extensions** (rail NoPixel/Fortnite entries, then one extension
   view) — extra rewards from Twitch Extensions, switched on per game.

Kick (the tour switches platform here):

9. **Kick level and streak** (the outlined pill in the status strip) — viewer
   level, progress to the next level, daily watch streak.
10. **Daily challenges** (the Kick auto-claim challenges setting) — LurkLoot
    claims Kick daily challenges for you.

Both:

11. **Activity** (Activity view, event list) — what LurkLoot has done: claims,
    channel switches, campaigns finished.
12. **Settings** (Settings view, the Drops group) — strategy, auto-claim, skip
    unfinishable drops; also points at Farming tabs (tabless mode, muting) and
    Notifications.

**Done card** (centred, no cut-out) — upbeat and fun, e.g. "You're set! Let's
get farming these drops!" plus a short tip: sign in to Twitch and/or Kick on
their official websites in this browser (LurkLoot never asks for your
credentials), then switch on the platform you want to farm with its toggle.
The card is the same for everyone; it does **not** inspect the user's real
sign-in or automation state, because LurkLoot cannot know which platforms they
want to farm. One button finishes the tour (e.g. **Let's go!**), returning the
popup to the user's real snapshot on the Queue view, on the platform they had
selected before the tour.

**One spotlight per step** *(my call)*. Each step has exactly one target
rectangle. Where a step above names several things: step 4 spotlights the
"Then by" row together with the first campaign row (one box around both, which
are adjacent at the top of the queue); step 8 opens an extension view first,
then spotlights the rail's NoPixel/Fortnite entries; step 12 spotlights the
Drops group only, and its copy mentions Farming tabs and Notifications. There
are no sub-steps, so the counter is always `n / 12`.

Copy above is intent, not final wording. Final copy is short (one or two
sentences per step), English first, then localized.

## Look and behaviour

- **Scrim:** dark, roughly 55–65% opacity, covering the whole popup (rail
  included). The UI underneath stays faintly visible.
- **Spotlight:** the current target shows through a rounded cut-out with a
  subtle ring/outline and a little padding. Implementation of the cut-out
  (SVG mask, box-shadow, clip-path) is the builder's choice.
- **Message box:** anchored to the target, placed on whichever side has room
  (below/above/beside), clamped inside the popup. Never covers its own target.
  It is the focusable, keyboard-reachable element: focus moves into it each
  step; Tab cycles Back/Next/Skip; Escape = Skip; Enter/ArrowRight = Next and
  ArrowLeft = Back are reasonable additions.
- **Blocking input:** the popup content is `inert` while the tour is open, and
  the scrim swallows pointer events, including on the cut-out area. Scrolling
  needed to bring a target into view is done by the tour, not the user.
- **Motion:** the cut-out and box glide between targets. Under
  `prefers-reduced-motion: reduce` (the maintainer's browser has it on) they
  jump with no animation; check both modes.
- **Theme:** works in light and dark, matching the existing popup tokens.
- **Popup notices:** the update notice, rate nudge, GitHub-star nudge, tips
  banner and any open dropdown/tooltip must not appear during the tour or shift
  targets mid-step.
- **Accessibility:** the message box is a labelled dialog
  (`role="dialog"`, `aria-modal`), the step title is its label, and the
  progress counter is announced.

## Demo data

The tour renders the popup on demo data from `@lurkloot/popup-ui`'s
`demo.ts`. Some steps need data the demo may not have yet. *(My call:)* add it
behind an opt-in tour scenario on `createDemoPopupAdapter` (e.g.
`{ scenario: "tour" }`), so the store screenshots, promo artwork and the
landing-site demo, which share the default demo data, do not change. The tour
scenario needs:

- Kick `accountProgress` with a level and a non-zero streak (exists; verify the
  pill renders).
- At least one pinned campaign, a favourite game, strategy-ranked campaigns and
  an unlinked campaign, so all queue groups in step 3 are visible.
- Completed and expired campaigns for step 5.
- A populated idle watchlist.
- `twitchExtensions` summaries so the NoPixel/Fortnite rail entries and one
  extension view render meaningfully for step 8.
- A handful of activity events for step 11.

## Architecture constraints

- The tour UI lives in `@lurkloot/popup-ui` (it is popup UI, host-agnostic);
  the "should it show" decision is the host's, via the optional adapter hooks.
- The extension-side flag lives in an extension `src/core/` module beside
  `updateNotice.ts`; `background.ts` wires install and reset to it.
- Nothing platform-specific is branched in shared mechanics; the tour's step
  list may name views and platforms, as it is UI content.
- Follow `CLAUDE.md` for locales: add English keys to
  `packages/locales/messages/en.json`, delegate every other locale's copy to an
  inexpensive subagent (Haiku or cheapest capable), preserve brand names and
  "farm".
- Add tests: install sets the flag and update does not; reset re-arms it;
  dismiss clears it; the tour does not render without the adapter hooks;
  step navigation (next/back/skip/escape) and that the tour never calls the
  real adapter's `send` with a mutating message.
- Update `docs/architecture.md` with the new flag/owner.

## Left to the builder

- How the popup swaps to demo data and lets the tour drive the view and
  platform: e.g. a tour mode inside `Popup.tsx` that uses the demo adapter's
  snapshot and a controlled `view`/`platform`, or rendering a second `Popup`
  instance on the demo adapter beneath the overlay. Whatever is chosen must
  satisfy the anti-goals (no real writes, clean hand-back).
- How targets are located (e.g. `data-tour="status-strip"` attributes on the
  existing elements) and how resize/scroll re-measures them.
- Exact step copy, within the intent above.
- Whether an unfinished tour (popup closed mid-way) resumes at the same step
  rather than restarting at the welcome card; restarting is the default.
