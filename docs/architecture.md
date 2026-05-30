# Architecture

Stream Farmer is a WXT browser extension that farms Twitch and Kick drops by opening normal, visible, pinned, muted watch tabs. It does not store credentials, export cookies, or emulate watching without a page.

## Runtime Components

- `entrypoints/background.ts` wires browser events to `createBackgroundController`.
- `src/background/controller.ts` handles alarms, popup messages, tab-removal recovery, notifications, and persistence.
- `src/core/scheduler.ts` owns campaign selection, fallback selection, auto-claiming, retry/backoff, and watch-tab lifecycle decisions.
- `src/platforms/*.ts` implement the `PlatformAdapter` contract for Twitch and Kick.
- `entrypoints/*.content.ts` start playback telemetry on Twitch/Kick pages.
- `entrypoints/popup/` renders the React popup and sends runtime messages such as `getSnapshot`, `saveSettings`, `tickNow`, and `claimReward`.

State and settings are loaded and saved through `src/core/storage.ts` in browser storage. The scheduler keeps separate `WatchSession` and campaign lists for `twitch` and `kick`.

## Scheduler Flow

Each alarm tick runs both platforms independently:

1. Stop or pause the platform if global automation or that platform is disabled.
2. Discover campaigns through the platform adapter.
3. Read current reward progress and merge it into campaign state.
4. Auto-claim claimable rewards when `autoClaim` is enabled.
5. Choose the best campaign/channel, or a Permawatch fallback streamer if no eligible campaign is available.
6. Reuse the current watch tab when it is still live, category-compatible, and playback telemetry is healthy.
7. Open or update a pinned muted tab for the selected channel.
8. Record events, update session state, and apply exponential backoff after platform errors.

Campaign ordering is shared across platforms: explicit campaign priority, game priority, optional lowest-availability mode, ending soonest, then name.

## Same-Origin Fetching

Most platform calls go through `fetchJsonInPage` in `src/core/tabs.ts`. It finds or opens a tab on the platform origin, then executes `fetch` in the page `MAIN` world. This preserves the browser's normal logged-in session and page clearance context.

For Kick, `pageFetchJson` reads the `session_token` cookie from the Kick page context and adds it as a bearer token for `web.kick.com` API calls. For Twitch, GraphQL requests use Twitch's public web client id and normal browser credentials unless a public channel check explicitly passes `credentials: "omit"`.

## Twitch Integration

`TwitchAdapter` uses Twitch GraphQL at `https://gql.twitch.tv/gql` with persisted query hashes and the public Twitch web client id.

- Campaign discovery calls `Inventory` and `ViewerDropsDashboard`, then fetches `DropCampaignDetails` for active/upcoming connected campaigns.
- Progress refresh re-reads `Inventory`; while watching, it also queries `DropCurrentSessionContext` to update the current reward's watched minutes.
- Candidate discovery prefers campaign allowed-channel data. If none exists, it queries `GameDirectory` with the DropsEnabled tag and sorts candidates by viewer count.
- Channel validation calls `StreamInfo` with an inline public query and anonymous credentials to avoid logged-in integrity-token failures. If GraphQL fails, it falls back to parsing the channel page HTML.
- Reward claiming calls `DropsPage_ClaimDropRewards`.
- Channel points claiming checks `ChannelPointsContext` and submits `ClaimCommunityPoints` when a claim is available.

## Kick Integration

`KickAdapter` uses Kick JSON APIs from the Kick page context.

- Campaign discovery fetches `https://web.kick.com/api/v1/drops/campaigns`.
- Progress refresh fetches `https://web.kick.com/api/v1/drops/progress`.
- Candidate discovery prefers campaign allowed-channel data. Otherwise it queries `https://web.kick.com/api/v1/livestreams` with `category_id`, sorted by viewer count.
- Channel validation calls `https://kick.com/api/v2/channels/{username}` and checks live state plus category id. If that fails, it falls back to parsing the channel page HTML.
- Reward claiming posts to `https://web.kick.com/api/v1/drops/claim` with campaign, reward, and claim identifiers.

## Watch Tabs and Playback Telemetry

Both adapters use the shared `openPinnedMutedTab` and `stopWatchTab` helpers. The extension reuses an existing managed tab when possible, updates it to the selected channel URL, pins it, mutes it, and leaves it inactive. If a managed tab is closed manually, the background controller triggers a fresh scheduler tick.

Content scripts on `https://www.twitch.tv/*` and `https://kick.com/*` mute all video elements, attempt playback, and report telemetry every five seconds. The scheduler treats playback as healthy only when recent telemetry shows at least one muted, playing video. Repeated offline, category mismatch, or unhealthy playback checks cause the scheduler to switch channels or stop the session according to `offlineRetryLimit`.

## Popup and Manual Actions

The popup never calls Twitch or Kick directly. It requests snapshots and sends settings or action messages to the background controller. Manual reward claims are routed through the platform adapter so state updates, notifications, and event logging stay consistent with automated claims.
