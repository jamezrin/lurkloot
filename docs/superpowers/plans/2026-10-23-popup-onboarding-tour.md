# Popup Onboarding Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skippable, click-to-advance spotlight tour of the popup, on demo data, shown once to fresh installs and again after a reset.

**Architecture:** The extension background owns a `pendingOnboarding` flag in `storage.local` (set on install and by `resetStorage`), exposed to the popup through two optional `PopupAdapter` hooks. `@lurkloot/popup-ui`'s exported `Popup` becomes a thin wrapper: while the tour runs it mounts the existing popup (renamed `PopupFrame`) on a tour-scenario demo adapter in preview mode, drives its view/platform through a new `tour` prop, and renders the overlay inside the frame's `<main>`. When the tour ends it mounts the real frame fresh. The real adapter is never handed to the frame during the tour, so real writes are structurally impossible.

**Tech Stack:** TypeScript, React 19, Tailwind, WXT, Vitest + linkedom.

**Spec:** `docs/superpowers/specs/2026-10-23-popup-onboarding-tour-design.md`

## Global Constraints

- Fresh installs (`runtime.onInstalled` `reason === "install"`) and resets only; never on `update`/`chrome_update`/`shared_module_update`.
- No replay entry point anywhere.
- Hosts without `getPendingOnboarding` (site demo, screenshots/promo, in-page panel) never show the tour.
- The flag is **not** in `ExtensionSettings`.
- No diagnostics step or callout.
- Scrim opacity 0.6 (inside the spec's 55–65% range), colour zinc-950 (`rgba(9, 9, 11, 0.6)`), the same in light and dark.
- Under `prefers-reduced-motion: reduce`, no transitions (Tailwind `motion-safe:` only).
- Counter is always `n / 12`; one spotlight rectangle per step.
- Locale copy: English in `en.json`; the other 16 catalogs are translated by a cheap subagent (Haiku). Keep `$1`/`$2`, the brand names (LurkLoot, Twitch, Kick, NoPixel, Fortnite) and "farm". No `diagnostic*` keys.
- Commits: Conventional Commits, scope `popup` (or `extension`, `locales`, `docs`).

## Review Focus

1. **Popup closed mid-tour:** the flag must stay set, and reopening starts again at the welcome card. Test in Task 5.
2. **Reset from Settings:** the welcome card appears without the popup being reopened. Test in Task 5.
3. **No real traffic during the tour:** the real adapter's `send` gets zero calls between the welcome card and finish/skip. Test in Task 5.
4. **`getPendingOnboarding` rejects:** treat it as not pending and render the real popup, never a blank popup. Test in Task 5.
5. **Step target missing from the DOM** (data didn't render): the card falls back to centred with no cut-out, and Next still works. Test in Task 3 (placement) and Task 5.

---

### Task 1: Extension-owned onboarding flag

**Files:**
- Create: `packages/extension/src/core/onboarding.ts`
- Modify: `packages/extension/src/core/storage.ts` (`resetStorage`, ~line 126)
- Modify: `packages/extension/entrypoints/background.ts` (`onInstalled` listener, ~line 553)
- Modify: `packages/popup-ui/src/types.ts` (`PopupAdapter`)
- Modify: `packages/extension/entrypoints/popup/app.tsx` (`createExtensionPopupAdapter`, next to the changelog hooks ~line 58)
- Test: `packages/extension/tests/onboarding.test.ts` (new), `packages/extension/tests/storageMigration.test.ts`

**Interfaces:**
- Produces (extension): `PENDING_ONBOARDING_KEY = "pendingOnboarding"`; `loadPendingOnboarding(): Promise<boolean>`; `armPendingOnboarding(): Promise<void>`; `dismissPendingOnboarding(): Promise<void>`; `armOnboardingForInstall(reason: string): Promise<void>` (arms only when `reason === "install"`).
- Produces (popup-ui `PopupAdapter`): `getPendingOnboarding?(): Promise<boolean>;` and `dismissPendingOnboarding?(): Promise<void>;`, with a comment matching the changelog hooks' ("demo/site hosts and the in-page panel omit these, which keeps the tour out of them").

- [ ] **Step 1: Write the failing tests.** In `onboarding.test.ts`, mock `wxt/browser` with an in-memory `storage.local` (same shape as `storageMigration.test.ts`). Tests:
  - `armOnboardingForInstall("install")` → `loadPendingOnboarding()` resolves `true`.
  - `armOnboardingForInstall("update")` and `("chrome_update")` → `false`.
  - `dismissPendingOnboarding()` after arming → `false`, and the key is gone from storage.
  - A non-boolean stored value (`"yes"`) → `false`.

  In `storageMigration.test.ts`, update "clears every local key before restoring canonical defaults" so the expected keys are `["pendingOnboarding", "schedulerState", "settings"]` and `mocks.values.pendingOnboarding === true`.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/onboarding.test.ts tests/storageMigration.test.ts`. Expected: FAIL (module missing; key list mismatch).
- [ ] **Step 3: Implement `onboarding.ts`**, modelled on `updateNotice.ts`. In `resetStorage`, add `[PENDING_ONBOARDING_KEY]: true` to the same `browser.storage.local.set` call that restores the defaults; import the key from `onboarding.ts`. In `background.ts`'s `onInstalled`, call `await armOnboardingForInstall(details.reason)` after `ensureInstalledAt()`. Add the two adapter hooks to `PopupAdapter` and wire `loadPendingOnboarding`/`dismissPendingOnboarding` into `createExtensionPopupAdapter`. Do **not** add them to `createInPagePanelAdapter` or `createDemoPopupAdapter`. Extend the in-page adapter's header comment list (`inPagePanelAdapter.ts` ~line 22) with the two hook names.
- [ ] **Step 4: Run** the same tests plus `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): arm the onboarding tour on install and reset`.

---

### Task 2: Tour demo scenario

**Files:**
- Modify: `packages/popup-ui/src/demo.ts`
- Test: `packages/extension/tests/popupDemoTour.test.ts` (new)

**Interfaces:**
- Produces: `createDemoPopupAdapter(options?: { locale?: SupportedLocale; version?: string; scenario?: "default" | "tour" })`. Omitting `scenario` keeps today's output byte-for-byte.

- [ ] **Step 1: Write the failing tests.** Send `getSnapshot` and `getActivity` through `createDemoPopupAdapter({ scenario: "tour" })`:
  - `settings.showTips === false`.
  - `settings.platform.twitch.unlinkedCampaigns === "last"`, and at least one Twitch campaign has `accountLinked: false` with `status: "active"`.
  - Twitch still has a pin (`campaignPins` non-empty) and a favourite category.
  - At least one Twitch campaign has every reward `claimed`, and one has `status: "expired"`.
  - `state.twitchExtensions?.nopixel` and `?.fortnite` are defined.
  - `state.accountProgress.kick` has `streakDays > 0`.
  - `getActivity` for `twitch` and for `kick`, with `category: "activity"`, returns ≥ 3 events each, every one `category: "activity"` with a `code`.
  - Default scenario: `state.twitchExtensions` is undefined, `getActivity` returns `[]`, and `settings.platform.twitch.unlinkedCampaigns === "include"`.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/popupDemoTour.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `scenario` into `handleDemoMessage`/`demoSnapshot`. For the tour, layer the additions onto the default snapshot rather than forking it. Build the `twitchExtensions` summaries from the `TwitchExtensionSummary` type in `@lurkloot/shared/models`. For activity events, use codes the popup's activity renderer already localizes (see `packages/popup-ui/src/activity.logic.ts`), e.g. reward claimed, channel switched, campaign finished, with `at` timestamps over the last few hours.
- [ ] **Step 4: Run** the tests plus `tests/popupShell.test.tsx`, which uses the default demo. Expected: PASS.
- [ ] **Step 5: Commit** `feat(popup): add an onboarding tour demo scenario`.

---

### Task 3: Tour model and placement logic

**Files:**
- Create: `packages/popup-ui/src/onboardingTour.logic.ts`
- Test: `packages/extension/tests/onboardingTourLogic.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface TourStep {
    id: string;
    platform: Platform;
    view: PopupView;
    settingsFocus?: string;      // passed to the frame's settingsFocus (group/section id)
    targets: readonly string[];  // CSS selectors; the spotlight is the union of their rects
    titleKey: string;
    bodyKey: string;
  }
  export const TOUR_STEPS: readonly TourStep[]; // exactly 12, in the table below
  export type TourPhase =
    | { kind: "loading" } | { kind: "hidden" } | { kind: "welcome" }
    | { kind: "step"; index: number } | { kind: "done" };
  export type TourAction = "arm" | "disarm" | "start" | "next" | "back" | "skip" | "finish";
  export function tourReducer(phase: TourPhase, action: TourAction): TourPhase;
  export function dismissesForGood(action: TourAction): boolean; // true for "skip" | "finish"
  export interface Rect { top: number; left: number; width: number; height: number }
  export function unionRect(rects: readonly Rect[]): Rect | null;      // null for []
  export function clampTarget(target: Rect, frame: { width: number; height: number }, maxHeightRatio?: number): Rect; // default 0.55: keep the top part, clip to frame
  export function placeCard(target: Rect | null, card: { width: number; height: number }, frame: { width: number; height: number }): { top: number; left: number; side: "below" | "above" | "right" | "left" | "center" };
  ```
- Step table (selectors are the `data-tour` anchors added in Task 4; copy keys are added in Task 5):

  | # | id | platform | view | settingsFocus | targets | titleKey / bodyKey |
  |---|----|----------|------|---------------|---------|--------------------|
  | 1 | statusStrip | twitch | queue | – | `[data-tour="status-strip"]` | tourStatusStripTitle / Body |
  | 2 | platformSwitch | twitch | queue | – | `[data-tour="platform-switch"]` | tourPlatformTitle / Body |
  | 3 | queueOrder | twitch | queue | – | `[data-tour="queue-list"]` | tourQueueOrderTitle / Body |
  | 4 | queueControls | twitch | queue | – | `[data-tour="queue-strategy"]`, `[data-tour="queue-list"] [data-campaign-id]` | tourQueueControlsTitle / Body |
  | 5 | completed | twitch | completed | – | `[data-tour="completed-list"]` | tourCompletedTitle / Body |
  | 6 | games | twitch | games | – | `[data-tour="games-mode"]` | tourGamesTitle / Body |
  | 7 | watchlist | twitch | watchlist | – | `[data-tour="watchlist"]` | tourWatchlistTitle / Body |
  | 8 | extensions | twitch | nopixel | – | `[data-tour="rail-extensions"]` | tourExtensionsTitle / Body |
  | 9 | kickProgress | kick | queue | – | `[data-account-progress="kick"]` | tourKickProgressTitle / Body |
  | 10 | kickChallenges | kick | settings | `kick` | `[data-tour="kick-challenges"]` | tourKickChallengesTitle / Body |
  | 11 | activity | kick | activity | – | `[data-tour="activity-list"]` | tourActivityTitle / Body |
  | 12 | settings | kick | settings | `general.drops` | `[id="settings-group-general.drops"]` | tourSettingsTitle / Body |

  Each Body key is the Title key with `Title` replaced by `Body`.

- Reducer rules: `loading` + `arm` → `welcome`; `loading` + `disarm` → `hidden`; `hidden` + `arm` → `welcome` (reset re-arms); `welcome` + `start` → `step 0`; `step i` + `next` → `step i+1`, and from the last step → `done`; `step i` + `back` → `step i-1`, staying at 0; `skip`/`finish` from `welcome`, `step` or `done` → `hidden`; any other pair returns the same phase object.
- Placement rules: gap 12px and frame margin 8px. Try below, then above, then right, then left, taking the first side where the card fits without overlapping the target; clamp to the frame. A `null` target gives `center`. If no side fits, the card goes `below`, clamped inside the frame.

- [ ] **Step 1: Write the failing tests:**
  - `TOUR_STEPS.length === 12`; ids are unique; every `titleKey`/`bodyKey` exists in `packages/locales/messages/en.json`. Mark this one test `it.todo` until Task 5 adds the keys, then turn it on.
  - Steps 1–8 are `twitch`, steps 9–12 are `kick`.
  - No step's targets mention `diagnostic`.
  - Reducer: every rule above, including `back` at 0, `next` on index 11 → `done`, and `hidden` + `arm` → `welcome`.
  - `dismissesForGood` is true only for `skip` and `finish`.
  - `unionRect([{0,0,10,10},{20,5,10,10}])` → `{top:0,left:0,width:30,height:15}`; `unionRect([])` → `null`.
  - `clampTarget` on a 720×600 frame with a target of height 500 → height 330.
  - `placeCard`: target at the top → `below`; target at the bottom → `above`; tall left-side target → `right`; `null` → `center`, centred within the frame; the result never extends past the 8px margin.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/onboardingTourLogic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `onboardingTour.logic.ts`. Pure; no DOM, no React.
- [ ] **Step 4: Run** the test. Expected: PASS (one todo).
- [ ] **Step 5: Commit** `feat(popup): model the onboarding tour steps`.

---

### Task 4: Frame tour mode and anchors

**Files:**
- Modify: `packages/popup-ui/src/Popup.tsx`: rename the component to `PopupFrame` (not exported from `index.ts`) and add the `tour` prop. `Popup` itself is rewritten in Task 5; until then, keep `export function Popup(props) { return <PopupFrame {...props} />; }` so nothing breaks.
- Modify, adding `data-tour` anchors: `statusStrip.tsx` (root → `status-strip`), `shell.tsx` (platform switch → `platform-switch`, the extension-items group wrapper → `rail-extensions`), `queue.tsx` (list root → `queue-list`, the "Then by" control → `queue-strategy`), `completed.tsx` (root → `completed-list`), `games.tsx` (mode toggle at ~line 294 → `games-mode`), `idleWatchlist.tsx` (channel list → `watchlist`), `activity.tsx` (event list → `activity-list`), `settingsRegistry.tsx` (Kick `claimEntry` render → `kick-challenges`). Use a wrapping element only where the component exposes no root you can attribute; if `SettingRow` doesn't forward attributes, add an optional `tourId?: string` prop that renders `data-tour`.
- Test: `packages/extension/tests/popupTourFrame.test.tsx` (new; copy the linkedom `mountPopup` harness from `popupShell.test.tsx`)

**Interfaces:**
- Consumes: `createDemoPopupAdapter({ scenario: "tour" })` (Task 2); `PopupView`, `Platform`.
- Produces:
  ```ts
  export interface PopupTourFrame {
    view: PopupView;
    platform: Platform;
    settingsFocus?: string;
    overlay: React.ReactNode;
  }
  export function PopupFrame(props: { adapter: PopupAdapter; initialState?: PopupInitialState; tour?: PopupTourFrame }): React.ReactElement;
  ```
  Behaviour when `tour` is set:
  - Each time `tour.platform`, `tour.view` or `tour.settingsFocus` changes, switch the frame to them, platform first and then view, using the existing `selectPlatform`/`changeView(view, focus)` paths.
  - Wrap `<main>`'s existing children in `<div inert className="contents">`, and render `tour.overlay` as the last child of `<main>`, inside the i18n/runtime providers.
  - The activity effect's `preview` guard (`Popup.tsx` ~line 299) becomes `(preview && !tour)`, so the tour's demo activity loads.

- [ ] **Step 1: Write the failing tests.** Mount `PopupFrame` on the tour demo adapter with `initialState={{ preview: true }}` and `tour={{ view, platform, overlay: <div data-test-overlay /> }}`:
  - For every row in `TOUR_STEPS`, render with that row's view, platform and settingsFocus, and assert `main[data-view]` equals the view, `main[data-platform]` equals the platform, and `container.querySelector(target)` is non-null for every one of the step's targets.
  - `[data-test-overlay]` is inside `main`, and `main > div[inert]` contains the rail.
  - Without `tour`, no element has `inert` (default rendering unchanged).
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/popupTourFrame.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the rename, the prop and the anchors.
- [ ] **Step 4: Run** the test plus `pnpm test` (the whole extension suite, since `Popup.tsx` is shared). Expected: PASS.
- [ ] **Step 5: Commit** `feat(popup): let the tour drive the popup frame`.

---

### Task 5: Overlay, `Popup` wrapper and English copy

**Files:**
- Create: `packages/popup-ui/src/onboardingTour.tsx`
- Modify: `packages/popup-ui/src/Popup.tsx` (the `Popup` wrapper)
- Modify: `packages/locales/messages/en.json`
- Test: `packages/extension/tests/onboardingTour.test.tsx` (new); turn on the todo from Task 3

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `export function OnboardingOverlay(props: { phase: Exclude<TourPhase, { kind: "loading" | "hidden" }>; onAction(action: TourAction): void }): React.ReactElement`.

**Wrapper (`Popup`):**
- If `initialState?.preview` is set or `adapter.getPendingOnboarding` is missing, render `<PopupFrame adapter={adapter} initialState={initialState} />` exactly as today.
- Otherwise hold `TourPhase` in `useReducer(tourReducer, { kind: "loading" })`. On mount, call `getPendingOnboarding()`: dispatch `arm` if it returns true, `disarm` if it returns false or rejects. Render nothing while the phase is `loading`.
- On `skip`/`finish` (`dismissesForGood`), call `adapter.dismissPendingOnboarding?.()`. Swallow any rejection; the tour still closes.
- For `hidden`, render `<PopupFrame key="real" adapter={wrappedAdapter} />`. `wrappedAdapter` is a `useMemo` copy of the adapter whose `resetExtension` awaits the original and then dispatches `arm`.
- For any other phase, render `<PopupFrame key="tour" adapter={tourAdapter} initialState={{ preview: true, locale }} tour={…} />`:
  - `tourAdapter = useMemo(() => createDemoPopupAdapter({ scenario: "tour", version: adapter.version }), [adapter.version])`.
  - `locale = effectiveLocale("browser", adapter.getUiLanguage())`.
  - `tour.view`/`platform`/`settingsFocus` come from `TOUR_STEPS[index]` during a step, and are `queue`/`twitch` for the welcome and done cards.

**Overlay:**
- A root at `absolute inset-0 z-50` that captures all pointer events.
- Spotlight: an absolutely positioned div at the clamped union rect, padded 6px, `rounded-[10px]`, with `box-shadow: 0 0 0 9999px rgba(9,9,11,0.6)`, a 2px violet ring (use the popup's accent token), and `motion-safe:transition-all motion-safe:duration-300`. With no target (welcome/done, or the targets weren't found), render a plain full-frame scrim instead.
- Measuring: on each step change, query the step's selectors inside the overlay's closest `main`. If none match, retry on `requestAnimationFrame` for up to 30 frames, then fall back to centred. Call `scrollIntoPanel` (`primitives.tsx`) on the first match before measuring. Re-measure on the `scroll` event of `[data-scroll-panel]` and on `ResizeObserver` of `main`. Measure rects relative to `main`.
- Card: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title and `aria-describedby` at the body; `w-[300px]`, using the popup's existing card tokens for light and dark. Position it with `placeCard`.
  - Step cards show the counter `t("tourProgress", [String(index + 1), "12"])` with `aria-live="polite"`, and the buttons Skip, Back (hidden on step 0) and Next.
  - The welcome card shows `tourWelcomeTitle`/`Body`, Skip (`tourSkip`) and Start (`tourStart`).
  - The done card shows `tourDoneTitle`/`Body` and a Finish button (`tourFinish`).
  - Focus the primary button on every phase change.
- Keys, on a `keydown` listener for the document: Escape → `skip`; Enter → the primary action; ArrowRight → `next` and ArrowLeft → `back`, swapped when `dir === "rtl"`. The arrow keys work only during steps.

**English copy (exact), added to `en.json` next to the `tip*` keys:**

| key | message |
|-----|---------|
| tourWelcomeTitle | Welcome to LurkLoot |
| tourWelcomeBody | LurkLoot farms Twitch and Kick drops for you in the background. Want a quick look at how it works? |
| tourStart | Show me around |
| tourSkip | Skip |
| tourNext | Next |
| tourBack | Back |
| tourProgress | $1 / $2 |
| tourStatusStripTitle | Always in view |
| tourStatusStripBody | This strip shows what is being farmed right now and on which channel. The switch starts or stops farming on this platform. |
| tourPlatformTitle | Twitch and Kick |
| tourPlatformBody | Switch platforms here. Each one has its own queue, games and watchlist. |
| tourQueueOrderTitle | How the queue is ordered |
| tourQueueOrderBody | Pinned campaigns come first, then your favourite games, then everything else by the strategy you pick. Campaigns for unlinked accounts can be farmed last. |
| tourQueueControlsTitle | Make it yours |
| tourQueueControlsBody | Pin a campaign and drag pins to reorder them. Pick Ending soonest or Lowest availability under Then by. Exclude a campaign and it moves to Skipped, where you can bring it back. |
| tourCompletedTitle | Finished and expired |
| tourCompletedBody | Finished campaigns have every reward claimed. Expired ones ended before they were done. |
| tourGamesTitle | Choose your games |
| tourGamesBody | All farms every game except the ones you block. Include farms only the games you tick. Star a game to put its campaigns first. |
| tourWatchlistTitle | Idle Watchlist |
| tourWatchlistBody | When there are no drops to farm, LurkLoot watches these channels so you keep earning channel points, claimed for you. Watch-source priority in Settings decides when they are watched. |
| tourExtensionsTitle | Twitch Extensions |
| tourExtensionsBody | Some games hand out rewards through Twitch Extensions, like NoPixel and Fortnite. Switch each one on to farm those too. |
| tourKickProgressTitle | Your Kick level |
| tourKickProgressBody | On Kick, this pill shows your viewer level, how close you are to the next one and your daily watch streak. |
| tourKickChallengesTitle | Daily challenges |
| tourKickChallengesBody | LurkLoot can claim Kick's daily challenge rewards for you. Turn it on or off here. |
| tourActivityTitle | What LurkLoot did |
| tourActivityBody | Activity lists every claim, channel switch and finished campaign, so you can see what happened while you were away. |
| tourSettingsTitle | Useful settings |
| tourSettingsBody | The Drops group holds your strategy, auto-claim and skipping drops that cannot finish in time. Farming tabs and Notifications are right below. |
| tourDoneTitle | You're set! Let's get farming these drops! |
| tourDoneBody | Sign in to Twitch or Kick on their official websites in this browser. LurkLoot never asks for your credentials. Then switch on the platform you want to farm. |
| tourFinish | Let's go! |

Until Task 6 runs, the other catalogs fall back to English through the existing fallback catalog. `pnpm locales:check` will fail until then, which is expected.

- [ ] **Step 1: Write the failing tests.** Use the linkedom harness. Build a fake real adapter by spreading `createDemoPopupAdapter()` and adding a `vi.fn` `send` that counts calls, plus `getPendingOnboarding`, `dismissPendingOnboarding` and `resetExtension` mocks.
  - Pending is true → the dialog shows `Welcome to LurkLoot`, and the rail is inside `[inert]`.
  - Pending is false → no dialog, and the real frame renders (`main[data-view="queue"]`, nothing inert).
  - The hook is missing, or `initialState.preview` is set → no dialog, and `getPendingOnboarding` is never called.
  - `getPendingOnboarding` rejects → the real frame renders with no dialog (Review Focus 4).
  - Start, then Next ×12 → `main[data-view]` follows the `TOUR_STEPS` views and the counter reads `1 / 12` … `12 / 12`. The last Next shows the done card; Finish → `dismissPendingOnboarding` called once, the real frame renders, and no dialog remains.
  - Back from step 2 returns to step 1; step 1 has no Back button.
  - Skip on the welcome card, Skip mid-step and Escape each call dismiss once and render the real frame.
  - The real adapter's `send` is called 0 times from mount through Finish (Review Focus 3).
  - Unmount at step 5 → `dismissPendingOnboarding` is not called (Review Focus 1).
  - From the real frame, call the wrapped `resetExtension` (through the Settings reset flow, or by triggering the adapter the frame received) → the welcome card appears without remounting (Review Focus 2).
  - A step whose targets are missing (remove the `[data-tour="games-mode"]` node before advancing, or stub `querySelector`) still shows a centred card, and Next works (Review Focus 5).
  - In RTL (the tour locale `ar`), ArrowLeft advances.
  - Also enable the en-keys test from Task 3.
- [ ] **Step 2: Run** `pnpm --filter @lurkloot/extension exec vitest run tests/onboardingTour.test.tsx tests/onboardingTourLogic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the overlay, the wrapper and the copy.
- [ ] **Step 4: Run** the tests, `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Check it visually.** Run `pnpm dev`, clear the extension's storage, set `pendingOnboarding: true` and open the popup. Walk all 12 steps in light and dark, and with reduced motion on and off. Each cut-out must frame its target, and no card may overlap its target or leave the frame. Take screenshots for the PR.
- [ ] **Step 6: Commit** `feat(popup): add the onboarding tour`.

---

### Task 6: Translations

**Files:**
- Modify: `packages/locales/messages/{ar,cs,de,es,fr,hi,id,it,ja,ko,pl,pt_BR,ru,tr,uk,zh_CN}.json`

- [ ] **Step 1: Delegate.** Send one Haiku subagent per locale (or one per batch of 4). Give it the 34 `tour*` English entries from Task 5 and the rules: keep `$1`/`$2`; keep LurkLoot, Twitch, Kick, NoPixel and Fortnite untranslated; keep "farm" as the gaming term the catalog already uses (have the agent read that locale's existing `tip*` entries); keep the button labels short. Each agent returns JSON entries only.
- [ ] **Step 2: Integrate** the returned entries next to each catalog's `tip*` keys.
- [ ] **Step 3: Run** `pnpm locales:check && pnpm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(locales): translate the onboarding tour`.

---

### Task 7: Docs and full verification

**Files:**
- Modify: `docs/architecture.md`, adding to "Popup and Manual Actions" (~line 984)

- [ ] **Step 1: Document** the flag's owner (`src/core/onboarding.ts`; set by `onInstalled` on `install` and by `resetStorage`); the optional adapter hooks and which hosts omit them; the invariant that the tour frame only ever gets the demo adapter; and that the flag is not a setting, with the reason.
- [ ] **Step 2: Run** `pnpm check`, then `pnpm build && pnpm build:firefox`. Expected: all PASS.
- [ ] **Step 3: Commit** `docs(architecture): describe the onboarding tour flag`.
