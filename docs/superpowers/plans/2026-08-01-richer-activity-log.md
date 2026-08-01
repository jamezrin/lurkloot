# Richer Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every structured popup Activity event as a rich, accessible timeline card, with durable artwork and campaign links for drop events.

**Architecture:** Enrich campaign/reward activity payloads at their core emission sites, preserving optional presentation metadata through persistence and diagnostics. Create an exhaustive popup activity-card view model that maps every event code to display data, then render it through a focused card component while leaving diagnostics and text exports unchanged.

**Tech Stack:** TypeScript, React, Tailwind CSS v4, Lucide React, Vitest, WXT/pnpm workspace.

## Global Constraints

- `packages/core` stays browser-free; popup rendering and external-link opening live in `packages/popup-ui`.
- Diagnostic messages remain English literals and no diagnostic locale keys are added.
- Campaign links must be opened only through `openHttpsLink`.
- Presentation metadata is optional for persisted-record compatibility; never fabricate a URL.
- The Diagnostics tab and plain-text activity export preserve their existing behavior.
- Use two-space indentation, double quotes, semicolons, strict TypeScript, and explicit type imports.

---

## File structure

- `packages/shared/src/events.ts` — optional durable artwork and campaign-page metadata on campaign/reward activity data.
- `packages/core/src/core/scheduler.ts` — automatic reward-claim events copy metadata from the campaign/reward selected for a claim.
- `packages/core/src/background/controller.ts` — manual-claim and farming lifecycle events copy the same metadata.
- `packages/popup-ui/src/activity.logic.ts` — exhaustive activity-card view-model builder, retaining existing text formatter/export functions.
- `packages/popup-ui/src/activity.tsx` — timeline-card presentation and HTTPS campaign action.
- `packages/extension/tests/{eventContract,activityDiagnostics,scheduler,backgroundController,activityView,activityLogView}.test.{ts,tsx}` — focused contract, propagation, view-model, and DOM coverage.

### Task 1: Preserve campaign and reward presentation metadata in new activity records

**Files:**

- Modify: `packages/shared/src/events.ts:31-47`
- Modify: `packages/core/src/core/scheduler.ts:858-866`
- Modify: `packages/core/src/background/controller.ts:2324-2331,2652-2674`
- Modify: `packages/extension/tests/eventContract.test.ts`
- Modify: `packages/extension/tests/activityDiagnostics.test.ts`
- Modify: `packages/extension/tests/scheduler.test.ts`
- Modify: `packages/extension/tests/backgroundController.test.ts`

**Interfaces:**

- Produces: `CampaignRewardData` includes `rewardImageUrl?: string` and `campaignUrl?: string`.
- Produces: all new `farming_started`, `farming_stopped`, and `reward_claimed` events copy `campaign.url` and `reward.imageUrl` when defined.
- Consumes: `DropCampaign.url` and `DropReward.imageUrl` from `@lurkloot/shared/models`.

- [ ] **Step 1: Write failing event-propagation assertions**

Extend `TARGET` in `activityDiagnostics.test.ts` and the `farming_stopped` fixture in `eventContract.test.ts` with:

```ts
rewardImageUrl: "https://cdn.example.test/reward.png",
campaignUrl: "https://example.test/campaign",
```

Assert the mirror preserves both optional fields in `data`, while its English `message` remains exactly unchanged. In the existing automatic-claim scheduler test and manual-claim controller test, provide a campaign with `url` and a reward with `imageUrl`, then assert the emitted `reward_claimed.data` includes both values. Add lifecycle assertions for a started/stopped event with the same values.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `pnpm --filter @lurkloot/extension test -- activityDiagnostics eventContract scheduler backgroundController`

Expected: FAIL because `CampaignRewardData` rejects the extra fields and emit sites do not include them.

- [ ] **Step 3: Extend the shared contract and emission sites minimally**

In `events.ts`, define the optional fields alongside existing IDs/names:

```ts
type CampaignRewardData = {
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
  rewardImageUrl?: string;
  campaignUrl?: string;
};
```

At each site that has `campaign` and `reward`, append only defined values:

```ts
...(reward.imageUrl ? { rewardImageUrl: reward.imageUrl } : {}),
...(campaign.url ? { campaignUrl: campaign.url } : {}),
```

Use the appropriate in-scope names (`before`, `after`, or claim candidates) without changing scheduler decisions, notification text, diagnostic wording, or existing IDs.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm --filter @lurkloot/extension test -- activityDiagnostics eventContract scheduler backgroundController`

Expected: PASS; all mirrors retain the metadata while diagnostic prose is unchanged.

- [ ] **Step 5: Commit the contract and propagation change**

```bash
git add packages/shared/src/events.ts packages/core/src/core/scheduler.ts packages/core/src/background/controller.ts packages/extension/tests/eventContract.test.ts packages/extension/tests/activityDiagnostics.test.ts packages/extension/tests/scheduler.test.ts packages/extension/tests/backgroundController.test.ts
git commit -m "feat(activity): preserve reward presentation metadata"
```

### Task 2: Build an exhaustive activity-card view model

**Files:**

- Modify: `packages/popup-ui/src/activity.logic.ts:1-205`
- Modify: `packages/popup-ui/src/index.ts`
- Modify: `packages/extension/tests/activityView.test.ts`

**Interfaces:**

- Produces: `buildActivityCard(event, t): ActivityCard | undefined` for structured activity records; it returns `undefined` for diagnostics and legacy records.
- Produces: `ActivityCard` with `icon`, `tone`, `summary`, `detail?`, `chips`, `reward?`, and `campaignUrl?` properties.
- Consumes: `ActivityHistoryRecord`, `TFunction`, `formatActivityEvent`, optional campaign/reward metadata from Task 1.

- [ ] **Step 1: Write failing exhaustive view-model tests**

In `activityView.test.ts`, define one fixture for every `ActivityEvent["code"]` using `satisfies Record<ActivityEvent["code"], ActivityHistoryRecord>`. Assert:

```ts
expect(buildActivityCard(events.reward_claimed, t)).toMatchObject({
  icon: "gift",
  tone: "success",
  reward: { name: "Golden Hat", imageUrl: "https://cdn.example.test/reward.png" },
  campaignUrl: "https://example.test/campaign",
});
expect(buildActivityCard(events.interruption, t)?.chips).toContain("runtime restart");
expect(buildActivityCard(events.auth_health_changed, t)?.detail).toContain("healthy");
expect(buildActivityCard(legacy, t)).toBeUndefined();
expect(buildActivityCard(diagnostic, t)).toBeUndefined();
```

For every fixture, assert `summary === formatActivityEvent(event, t)` so the existing localized sentence stays the accessibility baseline.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `pnpm --filter @lurkloot/extension test -- activityView`

Expected: FAIL because `buildActivityCard` and `ActivityCard` do not exist.

- [ ] **Step 3: Implement typed, exhaustive card-model mapping**

Add exported `ActivityCard`, `ActivityCardIcon`, and `ActivityCardTone` types plus:

```ts
export function buildActivityCard(event: ActivityHistoryRecord, t: TFunction): ActivityCard | undefined {
  if ("legacy" in event || event.category === "diagnostic") return undefined;
  const summary = formatCurrentActivity(event, t);
  switch (event.code) {
    case "reward_claimed":
      return {
        icon: "gift", tone: "success", summary,
        chips: [event.data.method],
        reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl },
        campaignName: event.data.campaignName,
        campaignUrl: event.data.campaignUrl,
      };
    case "farming_started":
      return { icon: "play", tone: "accent", summary, chips: event.data.channel ? [event.data.channel] : [], reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl }, campaignName: event.data.campaignName, campaignUrl: event.data.campaignUrl };
    case "farming_stopped":
      return { icon: "pause", tone: event.level === "error" ? "danger" : "warning", summary, chips: [formatStopReason(event.data.reason, t)], reward: { name: event.data.rewardName, imageUrl: event.data.rewardImageUrl }, campaignName: event.data.campaignName, campaignUrl: event.data.campaignUrl };
    case "challenge_claimed":
      return { icon: "trophy", tone: "success", summary, chips: [event.data.rarity, event.data.recurrence] };
    case "interruption":
      return { icon: "triangle", tone: event.level === "error" ? "danger" : "warning", summary, detail: event.data.detail, chips: [formatStopReason(event.data.reason, t)] };
    case "page_context_opened":
      return { icon: "monitor-up", tone: "accent", summary, chips: [event.data.host, formatPageContextOpenReason(event.data.reason, t)] };
    case "page_context_closed":
      return { icon: "monitor-down", tone: "muted", summary, chips: [event.data.host, formatPageContextCloseReason(event.data.reason, t)] };
    case "auth_health_changed":
      return { icon: "shield", tone: event.level === "error" ? "danger" : "warning", summary, detail: `${event.data.from} → ${event.data.to}`, chips: event.data.reason ? [event.data.reason] : [] };
    case "critical_failure_detected":
      return { icon: "octagon-alert", tone: "danger", summary, chips: [formatCriticalFailureReason(event.data.reason, t)] };
    case "critical_failure_cleared":
      return { icon: "refresh", tone: "success", summary, chips: [formatCriticalFailureReason(event.data.reason, t)] };
  }
}
```

Map start/stop to reward cards and all operational events to icon/tone/detail/chips appropriate to their existing structured fields. Use exhaustive `never` checking in the switch. Keep `formatActivityEvent` and `buildActivityExport` unchanged.

- [ ] **Step 4: Export and verify the view model**

Re-export `buildActivityCard` and its types from `packages/popup-ui/src/index.ts`, then run:

`pnpm --filter @lurkloot/extension test -- activityView`

Expected: PASS with every event code covered.

- [ ] **Step 5: Commit the activity view model**

```bash
git add packages/popup-ui/src/activity.logic.ts packages/popup-ui/src/index.ts packages/extension/tests/activityView.test.ts
git commit -m "feat(activity): model rich timeline cards"
```

### Task 3: Render accessible rich cards and safe campaign actions

**Files:**

- Modify: `packages/popup-ui/src/activity.tsx:1-170`
- Modify: `packages/extension/tests/activityLogView.test.tsx`

**Interfaces:**

- Consumes: `buildActivityCard` from Task 2, `ImageWithFallback`, `Pill`, `PopupRuntimeContext`, and `openHttpsLink`.
- Produces: `ActivityLog` renders card markup for structured activity records and preserves the compact text row for diagnostics/legacy entries.

- [ ] **Step 1: Write failing DOM tests for cards, fallbacks, and links**

Update `mount` in `activityLogView.test.tsx` to wrap `ActivityLog` in a `PopupRuntimeContext.Provider` with `adapter.openLink` as a spy. Use a reward event with `rewardImageUrl` and `campaignUrl`; assert:

```ts
expect(container.querySelector('img[alt="Golden Hat"]')?.getAttribute("src"))
  .toBe("https://cdn.example.test/reward.png");
expect(container.querySelector('[data-activity-card="reward_claimed"]')).not.toBeNull();
expect(container.querySelector('[data-activity-chip="automatic"]')).not.toBeNull();
```

Click the labelled campaign action and assert `openLink` receives the HTTPS URL. Add an `http:` URL fixture proving it does not call `openLink`, a no-image fixture proving the fallback tile is rendered, and one operational fixture proving its card carries its event-code marker and localized summary. Keep the existing Diagnostics assertions to prove diagnostic rows remain text-only.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `pnpm --filter @lurkloot/extension test -- activityLogView`

Expected: FAIL because the activity list has only text rows and no card/action markup.

- [ ] **Step 3: Implement focused card components inside `activity.tsx`**

Import Lucide icons used by `ActivityCardIcon`, `ImageWithFallback`, `Pill`, `PopupRuntimeContext`, `buildActivityCard`, and `openHttpsLink`. Replace the structured-event `li` body with an `ActivityTimelineCard` component that:

```tsx
const card = buildActivityCard(event, t);
if (!card) return <CompactActivityRow event={event} />;
return (
  <li data-activity-card={event.code} className="flex items-start gap-2 border-l-2 border-[var(--accent-ring)] px-2.5 py-2">
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--accent-softer)]">{card.reward ? <ImageWithFallback src={card.reward.imageUrl} alt={card.reward.name} fallback={<span>{card.reward.name.trim().charAt(0).toUpperCase()}</span>} /> : <EventIcon icon={card.icon} aria-hidden="true" />}</div>
    <div className="min-w-0 flex-1">
      <p>{card.summary}</p>
      {card.detail ? <p>{card.detail}</p> : null}
      {card.chips.map((chip) => <Pill key={chip}>{chip}</Pill>)}
    </div>
    {card.campaignUrl ? <button onClick={() => openHttpsLink(card.campaignUrl!, runtime.adapter.openLink)}>…</button> : null}
  </li>
);
```

Use a semantic `<button>` with an aria-label that includes the campaign name, stop propagation if needed, and avoid nested interactive controls. Implement a generated fallback tile using the first non-whitespace character of the reward name; do not render `<img>` without a usable source. Apply compact light/dark-safe Tailwind classes, visible keyboard focus, wrapping, and a severity border/indicator.

- [ ] **Step 4: Run focused UI and type tests**

Run: `pnpm --filter @lurkloot/extension test -- activityLogView activityView && pnpm --filter @lurkloot/popup-ui typecheck`

Expected: PASS; cards render every event class, campaign actions accept HTTPS only, and diagnostics/export behavior has not changed.

- [ ] **Step 5: Commit the card renderer**

```bash
git add packages/popup-ui/src/activity.tsx packages/extension/tests/activityLogView.test.tsx
git commit -m "feat(activity): render rich event timeline"
```

### Task 4: Verify the complete workspace change

**Files:**

- Verify: all files changed in Tasks 1-3

- [ ] **Step 1: Run formatting and static checks**

Run: `git diff --check && pnpm typecheck`

Expected: no whitespace errors and all workspace packages typecheck.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`

Expected: every CLI, extension, and site test passes.

- [ ] **Step 3: Inspect the final change**

Run: `git status --short && git log --oneline origin/develop..HEAD && git diff --stat origin/develop...HEAD`

Expected: only the three focused conventional commits plus this documentation commit; no generated assets, credentials, or unrelated files.
