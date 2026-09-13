# Tabless Twitch Extension acceptance audit

Scope: ship a reusable extension-support foundation and NoPixelV/Fortnite automation without requiring any Twitch channel tab, player, supervisor or overlay iframe. This audit preserves the full scope, including eligible-channel switching, giveaway joining and reward delivery. PR #541 remains draft; implementation coverage does not establish authenticated live earning.

Audited implementation: `a6aacaf5`. Latest CI run [34751942993](https://github.com/jamezrin/lurkloot/actions/runs/34751942993) passed verification, Chromium/Firefox packaging and both Docker architectures. Local `pnpm check` passed 2,186 extension tests, 196 CLI tests, script tests, workspace typechecks and site build. Test evidence below is deterministic; it cannot replace the live gates.

| Requirement | Current implementation evidence | Acceptance status |
| --- | --- | --- |
| Reusable browser-free foundation | `packages/core/src/extensions/`: descriptors, discovery, reducers and validated reports; `coreBoundary.test.ts` guards browser-free core. | Implemented and tested. |
| Authorization without Twitch tabs or frames | `session.ts` uses selected-channel normal Twitch GQL authorization; session/runtime tests require no tab APIs. User popup probe confirmed active, authenticated, linked authorization for both providers. | Authenticated acquisition proven; vendor earning is separate. |
| Privileged credential isolation | Session callbacks, driver cancellation and report allowlists; `twitchExtensionSession.test.ts`, `twitchExtensionReports.test.ts` and runtime credential-carrying report rejection. No persisted JWTs, vendor properties, pack IDs or cards. | Implemented and tested. |
| Optional provider access and independent opt-ins | Gesture-time scoped backend grants; background revalidation, revocation and race tests; settings default providers, takeovers and pack opening off. | Implemented and tested; installed-browser lifecycle remains open. |
| Fully tabless farming and eligible-channel switching | Background host provides independent supplemental targets to core; bounded batched directory/installation discovery; scheduler supplemental tests prohibit tab fallback, honor pause and exclusions. NoPixelV completion probes rotate through candidates. | Implemented and tested; authenticated earning growth remains open. |
| NoPixelV daily watchtime | Normal Bearer initialization ping, setup and authoritative daily counter reads. Screenshot showed 60/60. | Counter read proven; growth during tabless farming not proven. |
| NoPixelV giveaway joining | Join followed by authoritative membership refetch; cancellation and ambiguous submission guards. User tabless log confirms `giveaway_joined` on ssaab. HTTP 404 lookup blocks only giveaway reporting. | Authenticated entry proven; later browser lifecycle behavior remains open. |
| NoPixelV reward delivery and claiming | Owned pack-list read separately from daily completion; explicit automatic-opening opt-in, maximum five unattempted packs per refresh. Valid card response plus authoritative inventory removal required before `pack_opened` activity. Tests cover opt-in, retries, batches and late cancellation. | Implemented and tested; actual delivery and opening not proven live. |
| Fortnite background session and state | Normal hello/authenticate/join, ping, versioned state reads and bounded reconnect; `fortniteSocket.test.ts`, `fortniteState.test.ts`, `fortniteDriver.test.ts`. Anonymous extension-origin hello and public state reads succeeded. | Implemented and tested; authenticated vendor handshake/private schema acceptance not proven. |
| Fortnite capture farming | Only server-announced current sprite during an open interactive phase; cadence and ambiguous replay guards; activity requires authoritative participant counter increments. | Implemented and tested; actual captures and counter growth not proven live. |
| Fortnite rewards | Reads actual participant phase/reward state; collection size alone cannot complete rewards. Published client exposes no separate earning claim command; cosmetic rewards-seen mutation is excluded. | Implemented and tested; real reward delivery not proven live. |
| Optional Fortnite takeovers | Separate opt-in; server eligibility, channel allowance and cooldown gates; ownership confirmation with bounded retries before activity. | Implemented and tested; eligible live takeover not proven. |
| Disable, pause, revocation, logout, expiry, reconnect and restart | Runtime/permission/lifecycle tests cover authority loss, failed initialization, stale reports, expiry and reacquisition; background wires wake, settings, state and permission events. Chromium 116+ WebSocket cadence and Firefox MV2 supported. | Deterministic coverage proven; installed-browser lifecycle gate remains open. |
| Popup layout and provider-specific details | Compact channel/reason row; independently collapsible provider sections visible immediately when enabled; separate daily, giveaway and unopened-pack details. Actual compiled 400×600 popup QA used synthetic reports and checked Settings persistence, collapse, console errors and overflow. User approved the section direction. | Rendered coverage proven; statuses must still be verified during real provider earning. |
| Tracking, privacy and permission documentation | Issues #506–#511 track the complete tabless scope; #509 includes pack delivery/opening; foundation and store-readiness docs describe optional direct vendor communication. | Updated; issues remain open for their live gates. |

## Remaining release gates

- Observe NoPixelV daily counter growth with all Twitch channel tabs closed.
- Confirm real pack delivery and opted-in opening, including confirmed activity.
- Confirm Fortnite authenticated vendor session, captures, counter growth and actual reward state during an open phase; confirm an opted-in takeover when eligible.
- Exercise disable, manual pause, grant revocation, logout, authorization expiry and restart/reconnect on the supported installed-browser runtimes.
- Complete final review and satisfy the corresponding tracking issues before release.

The agent's disposable browser profiles do not have the user's normal Twitch login. No live authenticated earning result can be inferred from anonymous public reads or mocks. Previously declined Console/validation questions are not pending approvals and must not be repeated as an automatic continuation step. No credentials or network dumps are needed in any acceptance report.
