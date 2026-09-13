# Twitch Extension foundation implementation plan

> Superseded runtime plan: see `../specs/2026-09-12-tabless-twitch-extensions-design.md`.
> The user requires tabless operation without Twitch/provider frames.

Goal: Implement issue #507, the provider-neutral foundation for #506.
Spec: https://github.com/jamezrin/lurkloot/issues/507

Architecture: Pure descriptors and report contracts live in core. Browser registration and permissions live in extension. A same-frame relay validates every report before forwarding it; credentials remain inside the page driver closure.

Constraints: Existing required permissions must remain unchanged. Providers default off. No provider backend host grants. Chromium MV3 and Firefox MV2 must both work. No raw provider state or authorization material is persisted.

- [x] Registry: add tests resolving exact provider origins and rejecting foreign origins; implement immutable descriptors and contracts, export the registry.
- [x] Bridge: test source/origin, direction, protocol, provider, outstanding request and unsolicited-kind validation; test nested credential screening and allowlisted reports; implement protocol and relay.
- [x] Permissions and registration: test denial, grant, revocation, restart with vanished grant, registration rollback and both browser APIs; implement serialized lifecycle with injected settings/state ports.
- [ ] Overlay spike: verify both live overlays mount and authorize in pinned muted background tabs, collapsed. Record the result before implementing the driver host. If expansion is required, stop and reconsider the architecture.
- [ ] Driver host: test with a throwaway provider, renewed authorization, channel switch, stop/pagehide/relay loss teardown. Implement only after the spike passes.
- [ ] Integration: wire background lifecycle and optional manifest entries; verify required permission arrays against baseline build artifacts.
- [ ] Verification: focused tests, full tests, workspace typechecks, Chromium and Firefox builds, review diff, commit and open a PR into develop. Keep issue open if live acceptance remains unverified.

Status: live gate remains unverified; see `docs/twitch-extensions/foundation.md`. The tested primitives are ready for review, but #507 is not complete.
