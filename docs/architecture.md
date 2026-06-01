# Architecture

StreamMaxxer is a WXT browser extension that farms Twitch and Kick drops through normal logged-in browser sessions. It opens real watch pages in visible browser tabs, uses browser-tab muting for silence, and avoids storing credentials, exporting cookies, or bypassing platform page detection.

## Runtime Components

- `entrypoints/background.ts` registers extension lifecycle hooks, alarms, tab-removal handling, and runtime message handling.
- `src/background/controller.ts` coordinates settings/state persistence, scheduler ticks, popup messages, notifications, manual reward claims, and playback-control authorization.
- `src/core/scheduler.ts` owns platform-independent campaign selection, Watch Queue fallback selection, auto-claiming, retry/backoff, session state, and watch-tab lifecycle decisions.
- `src/platforms/adapter.ts` defines the `PlatformAdapter` contract. `src/platforms/twitch.ts` and `src/platforms/kick.ts` implement platform-specific discovery, progress, candidate, validation, claim, and tab preparation behavior.
- `src/core/tabs.ts` contains shared browser-tab management and page-context fetch helpers.
- `entrypoints/twitch.content.ts` and `entrypoints/kick.content.ts` start shared playback telemetry/control on platform pages.
- `entrypoints/popup/` renders the React popup and talks only to the background controller through runtime messages.

State and normalized settings are loaded and saved through `src/core/storage.ts`. The scheduler stores independent `WatchSession`, campaign, diagnostics, event, and managed-tab state for `twitch` and `kick`.

## Runtime Messages

The popup and content scripts do not call adapters directly. They send typed runtime messages from `src/core/messages.ts`:

- Popup messages: `getSnapshot`, `saveSettings`, `setRunning`, `setPlatformEnabled`, `setAutomation`, `tickNow`, and `claimReward`.
- Content-script messages: `getPlaybackControl` and `playbackTelemetry`.

`getPlaybackControl` is intentionally gated in the background controller. A content script may only control page video elements when its sender tab is the current watch tab for that platform. This prevents normal user-opened Twitch/Kick tabs from being modified.

## Settings Model

`mergeSettings` is the source of truth for defaults, migrations, and persisted-setting normalization. It fills missing keys from `DEFAULT_SETTINGS`, clamps numeric values, normalizes channel/game/campaign lists, and removes duplicate list entries.

Important setting groups:

- Global automation: `running`, `autoStartDropFarming`, per-platform `enabled`.
- Farming behavior: `autoClaim`, `autoClaimChannelPoints`, `watchQueueFallbackOnly`, `priorityMode`, `campaignPriorities`, `excludedCampaignIds`.
- Platform preferences: `platform[platform].watchQueueChannels`, `platform[platform].excludedChannels`, and `platform[platform].gamePriority`.
- Tab/playback behavior: `muteFarmingTabs`, `keepFarmingVideosUnmuted`, `autoCloseFinishedDrops`, `offlineRetryLimit`.
- Notifications: `notifyRewardEarned`, `notifyNoDropsLeft`.

The popup normalizes snapshots before rendering and normalizes patches before saving, so older stored settings get current defaults before they drive UI toggles.

## Scheduler Flow

Each scheduler tick runs enabled platforms independently:

1. Pause and clean up the platform if global automation or that platform is disabled.
2. Skip the platform while it is in exponential backoff after repeated platform errors.
3. Discover campaigns through the adapter and merge progress.
4. Auto-claim claimable rewards when enabled.
5. Select the best eligible campaign channel, or a Watch Queue fallback when no eligible campaign channel is available.
6. Decide whether to keep the current watch tab by checking channel liveness/category and recent playback telemetry.
7. Open, reuse, retarget, or stop the watch tab through the adapter.
8. Claim channel points when enabled and supported by the adapter.
9. Persist sessions, campaigns, managed-tab registrations, events, and backoff state.

Campaign ordering is shared across platforms: explicit campaign priority, platform game priority, campaign priority field, optional lowest-availability mode, ending soonest, then campaign name. Per-platform excluded drop channels filter campaign candidates only; they do not suppress Watch Queue fallback channels.

## Same-Origin Fetching

Most platform calls go through `fetchJsonInPage` in `src/core/tabs.ts`. It finds or opens a temporary tab on the platform origin, then executes `fetch` in the page `MAIN` world. This keeps requests inside the browser's normal logged-in session and any page clearance context.

For Kick, `pageFetchJson` reads `session_token` from the Kick page context and adds it as a bearer token for `web.kick.com` API calls. For Twitch, GraphQL requests use Twitch's public web client id and normal browser credentials unless a public channel check explicitly passes `credentials: "omit"`.

Temporary page-context tabs are reference-counted per origin and removed after the fetches complete when the extension created them. Existing user tabs reused for page-context fetches are not closed.

## Twitch Integration

`TwitchAdapter` uses Twitch GraphQL at `https://gql.twitch.tv/gql` with persisted query hashes and the public Twitch web client id.

- Campaign discovery calls `Inventory` and `ViewerDropsDashboard`, then fetches campaign details for active/upcoming connected campaigns.
- Progress refresh re-reads `Inventory`; while watching, it also queries `DropCurrentSessionContext` to update the current reward's watched minutes.
- Candidate discovery prefers campaign allowed-channel data. If none exists, it queries `GameDirectory` with the DropsEnabled tag and sorts by viewer count.
- Channel validation calls `StreamInfo` with an inline public query and anonymous credentials to avoid logged-in integrity-token failures. If GraphQL fails, it falls back to parsing channel page HTML.
- Reward claiming calls `DropsPage_ClaimDropRewards`.
- Channel points claiming checks `ChannelPointsContext` and submits `ClaimCommunityPoints` when a claim is available.

## Kick Integration

`KickAdapter` uses Kick JSON APIs from the Kick page context.

- Campaign discovery fetches `https://web.kick.com/api/v1/drops/campaigns`.
- Progress refresh fetches `https://web.kick.com/api/v1/drops/progress`.
- Candidate discovery prefers campaign allowed-channel data. Otherwise it queries `https://web.kick.com/api/v1/livestreams` with `category_id`, sorted by viewer count.
- Channel validation calls `https://kick.com/api/v2/channels/{username}` and checks live state plus category id. If that fails, it falls back to parsing channel page HTML.
- Reward claiming posts to `https://web.kick.com/api/v1/drops/claim` with campaign, reward, and claim identifiers.

## Watch Tabs

Both adapters use the shared `openPinnedMutedTab` and `stopWatchTab` helpers.

Watch-tab preparation:

- Reuses a registered extension-managed tab when possible.
- Reuses a user tab only when the current session was already using a non-managed user tab.
- Retargets stale/wrong URLs to the selected channel.
- Pins the tab and applies browser-level tab muting according to `muteFarmingTabs`.
- Briefly activates newly created, retargeted, missing-telemetry, stale-telemetry, or unhealthy-playback tabs when `keepFarmingVideosUnmuted` is enabled, then restores the previously active tab. This primes players that defer loading until foregrounded.
- Stores extension-managed tab ids in scheduler state so stale managed tabs can be cleaned up without closing arbitrary matching user tabs.

When a managed watch tab is manually closed, `background.ts` notifies the controller, which triggers a fresh scheduler tick if automation is running.

Stopping behavior depends on ownership and settings:

- Extension-managed watch tabs are closed when `autoCloseFinishedDrops` allows it.
- Reused user tabs are unmuted, unpinned, and left open.

## Playback Telemetry and Control

Content scripts run on all Twitch/Kick pages, but only the current watch tab is authorized to mutate video state or report useful telemetry.

Every five seconds, and after visibility/focus/player mutations, the content script asks the background for `PlaybackControl`:

- If `managed` is false, it does nothing.
- If `managed` is true and `keepVideosUnmuted` is true, it removes page-level video muting, sets nonzero video volume, attempts `video.play()`, and listens for later `volumechange`/`pause` events so platform player state changes can be corrected. The content script suppresses the `volumechange`/`pause` events its own mutations trigger to avoid a self-feeding control loop.
- Some browsers (notably Firefox) refuse to unmute media in a tab that has had no user gesture and pause the element instead. When the unmute is blocked, the content script re-mutes the video and replays it so playback keeps progressing (counted in blocked playback count); watch time is credited even while muted.
- It reports telemetry including video count, muted/unmuted video count, playing video count, blocked playback count, document visibility, ready state, current time, and duration.

The scheduler treats playback as healthy when recent telemetry shows at least one video and at least one playing video — muted or not, since the browser may keep a background video muted. The browser tab can still be muted; the platform-visible page video state is intentionally separate from browser tab audio output.

Repeated offline, category mismatch, or unhealthy playback checks cause the scheduler to switch channels or stop according to `offlineRetryLimit`.

## Popup and Manual Actions

The popup is a controller UI, not a platform client. It requests snapshots and sends setting/action messages to the background controller. Manual reward claims are routed through the platform adapter so state updates, notifications, and event logging stay consistent with automated claims.

The popup exposes platform-specific queues, excluded drop channels, game order, campaign priorities, notifications, and advanced playback settings. Changes that can affect the active scheduler target can request a targeted tick for the affected platform.
