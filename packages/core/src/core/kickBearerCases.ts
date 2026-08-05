// Shared test fixture: URLs asserted against every copy of the Kick
// session_token Bearer predicate (packages/core/src/core/tabs.ts's
// needsKickSessionBearer, packages/cli/src/transport/cycle.ts's kickHeaders,
// and tabs.ts's inlined pageFetchJson). Kept here rather than duplicated in
// each package's test suite so the three copies stay pinned to the same
// expectations. Not imported by any runtime code path.

// Genuinely authenticated endpoints that must receive the Bearer over https,
// true for every copy regardless of which extra protocols it accepts (only
// the CLI's WebSocket transport widens beyond https; see needsKickSessionBearer's
// `protocols` option and kickHeaders in packages/cli/src/transport/cycle.ts).
export const KICK_BEARER_POSITIVE_CASES: ReadonlyArray<readonly [string, string]> = [
  ["web.kick.com", "https://web.kick.com/api/v1/drops/campaigns"],
  ["bare kick.com identity endpoint", "https://kick.com/api/v1/user"],
  ["bare kick.com followed-live endpoint", "https://kick.com/api/v1/user/livestreams"],
];

// Near-misses for a genuinely authenticated endpoint: a look-alike host, an
// unintended subpath, or a plaintext/unencrypted downgrade of an endpoint that
// *does* receive the token over https (or, for the CLI transport, wss). None
// may receive it from any copy — including "ws://websockets.kick.com/viewer",
// the plaintext downgrade of the one endpoint whose bearer-eligible protocol
// set is wider than https alone.
export const KICK_BEARER_NEAR_MISS_CASES: ReadonlyArray<readonly [string, string]> = [
  ["look-alike host mentioning a Kick host", "https://evil.example/?r=web.kick.com"],
  ["look-alike host suffixing a Kick host", "https://web.kick.com.evil.example/api/v1/user"],
  ["subpath of the identity endpoint", "https://kick.com/api/v1/user/profile"],
  ["plaintext downgrade of an authenticated endpoint", "http://web.kick.com/api/v1/drops/progress"],
  ["plaintext downgrade of the WebSocket endpoint", "ws://websockets.kick.com/viewer"],
  ["public kick.com channel API", "https://kick.com/api/v2/channels/someone"],
];
