# Tabless Twitch Extension transport design

This replaces the iframe-dependent runtime design in #506/#507 following the
user's explicit requirement on 2026-09-12: Twitch Extension rewards must work
with tabless farming, without depending on Twitch tabs or their provider frames.
The existing PR #541 foundation is a draft; its frame-registration code is not
connected to production and is not the runtime to finish implementing.

## Verified findings

The user confirmed NoPixel's actual provider frame was mounted and had
`Twitch.ext.viewer.sessionToken` both foregrounded and backgrounded after initial
foreground activation, while LurkLoot was disabled. This confirms the normal
Twitch iframe path, but not fresh background mounting or reward accrual.

The live Twitch helper's `onAuthorized` setter removes prior listeners and
immediately emits existing authorization if available. It is not an additive
subscription; a production driver must not replace the vendor's callback. The
previous manual callback instructions have been corrected in conversation.

### Normal Twitch session acquisition does not require an iframe

On 2026-09-12 Twitch's published client asset
`https://assets.twitch.tv/assets/25470-21bb3773aacee3bd1b1a.js` contains
`CoordinatorExtensionsForChannel($channelID: ID!)`, reading
`user.channel.selfInstalledExtensions` with each installation and its
`token.jwt`. The client also contains `RefreshExtensionTokenMutation`, taking
an existing JWT and channel/extension IDs. These are Twitch's own operations,
not a token signed or manufactured by LurkLoot.

A reduced selected-channel query was tested against live GQL without loading
any Twitch page. It validated without schema errors and returned:

- `buddha` (136765278): active NoPixel, version 1.1.2, token present.
- `loserfruit` (41245072): Fortnite, version 1.1.2, token present.

Only token-presence booleans and public installation metadata were recorded;
no raw JWT, GQL body or credential was saved or logged. These requests were
anonymous, so they do not prove authenticated viewer identity or earning.

This corrects the original epic's assumption that the iframe is the only place
where a viewer JWT can be acquired. The documented public Helix endpoints
are not this viewer-session interface. GQL remains an internal Twitch API and
must have live-schema drift coverage and compatibility handling.

### Hidden embedding is not the selected solution

The current public supervisor script at
`https://supervisor.ext-twitch.tv/supervisor/v1/supervisor.js` accepts
`supervisor-init` only from Twitch-family parent origins. NoPixel's actual
viewer document response additionally has `frame-ancestors` excluding
`chrome-extension:` and `moz-extension:` ancestors. Merely nesting a supervisor
under a LurkLoot page does not solve these restrictions; ancestor checks cover
the whole chain. We will not remove CSP headers or impersonate an allowed origin.

References: https://dev.twitch.tv/docs/extensions and
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors

### Direct browser-extension-origin transports

A throwaway, separate Playwright Chromium extension-origin page, with no
Twitch channel tab, successfully requested the selected-channel GQL data for
both providers. NoPixel's progress endpoint was reachable from that origin.

NoPixel's current published bundle uses `Authorization: Bearer <JWT>`.
An anonymous read with that exact format returned 401. An earlier raw-JWT
probe also returned 401 and is superseded as an auth-format test. Neither
result establishes that an authenticated/identity-linked viewer will earn.
The current 1.1.2 bundle still exposes daily-watchtime progress and channel
eligibility/connection flags, but the older #509 version-1.0.0 details require
rechecking before provider implementation.

Fortnite's WebSocket accepted the normal `service.hello` envelope from the
throwaway extension origin, with `payload.properties: {}`. It returned a
server-issued device ID, with no client-generated device ID or stored session.
Only booleans about the response were emitted. The socket was closed after
hello; no sprite, giveaway, takeover or other competition command was sent.

The shipped socket client at
`https://x2nfeda4neuzvsp2zdqfln9nwxc7tp.ext-twitch.tv/x2nfeda4neuzvsp2zdqfln9nwxc7tp/1.1.2/d30ed22cccb992dd50c8f7bacd341e97/9731/js/653f13b31629e39cc68f.js`
uses stored properties when available and `{}` otherwise. Its server response
properties are retained by the vendor client. This corrects the old assumption
that a pre-existing local `epicDeviceId` is mandatory for hello. Authentication,
account linkage and reconnect/device lifetime remain to validate. LurkLoot will
not generate device identifiers or persist session/device credentials.

## Selected architecture

Keep provider descriptors, discovery batching, reducers and watch policy in
browser-free core. Execute bundled provider transports inside the extension's
privileged runtime, obtaining real viewer JWTs from the normal Twitch GQL
session transport. Providers never need a Twitch page, player, supervisor or
provider iframe for initialization. Whether tabless watch heartbeats actually
accrue NoPixel vendor watch time remains a provider-level live acceptance test;
JWT acquisition alone does not prove earning.

The acquisition source checks a normal logged-in session before querying,
selects only the intended active installation, checks channel binding and
expiry, rejects anonymous viewer credentials, and tells the driver whether
Twitch identity has been linked. Unlinked identity is a provider/UI blocker,
not a Twitch transport failure. Claims checks are consistency checks; the
provider backend still verifies the server signature.

No JWT or raw vendor/GQL body enters runtime messages, reports, snapshots,
activity, diagnostics, exports or persistent storage. Driver callbacks receive
credentials only within the privileged transport call. The acquisition helper
ignores callback return values and scrubs all transport/provider exceptions to
fixed outcome classes. Disabled providers never acquire a session or open a
vendor transport. Renewals must respect bounded polling/backoff and avoid
per-candidate discovery requests.

NoPixel direct HTTP calls need an optional backend-origin grant. Fortnite's
WebSocket is reachable without changing its Origin; its opt-in grant will be
scoped to the backend host using a supported HTTPS match pattern. The former
optional provider-frame origins and runtime content-script registration will
be replaced rather than adding both permission models. Required permissions
remain unchanged. No broad host grant, iframe CSP workaround or user credential
export is needed.

For Chromium 116 and later, sending or receiving WebSocket messages resets the
service-worker idle timer. Fortnite's normal ten-second service.ping cadence
therefore fits the documented thirty-second activity window without an
offscreen document or new required permission. The runtime must still recover
from browser shutdown, socket loss and worker restart by reacquiring the
selected-channel session and repeating the handshake. Resolve support for
older Chromium versions explicitly in the runtime implementation rather than
silently relying on this behavior. Firefox MV2 uses its persistent background
page. HTTP-only NoPixel work should run from existing scheduler alarms; no
artificial background keepalive is needed.

Reference: https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets

## Implementation sequence

1. Implement and test the selected-channel session source without connecting
   provider execution to production. This is implemented in
   `packages/extension/src/extensions/session.ts` with focused credential/lifecycle tests.
2. Validate authenticated viewer identity through the existing browser-session
   GQL transport. Never ask the user to paste a token; output booleans only.
3. Replace iframe-only grants/registration with optional backend-origin grants,
   then implement the background runtime lifecycle, cancellation, revocation,
   service-worker wake/reconnect handling and throwaway-driver tests.
4. Connect the new state, settings and tabless supplemental watch policy in #508.
5. Implement and verify NoPixel earning and entry in #509 using its current bundle.
6. Implement Fortnite session/rewards in #510 and interactive commands in #511.

The authenticated session and vendor earning tests remain unverified. The
session source is useful tested code, not a completed Twitch Extension feature.

## Read-only authenticated validation

Leave farming off. Open LurkLoot's popup and right-click inside it → Inspect.
Run this in the popup's Console, not the Twitch or provider iframe Console.
It uses the extension's already-authorized normal Twitch session locally and
returns only public provider IDs and booleans. It does not call vendor endpoints
or perform reward actions. No credential should be copied into chat or a file.
Close DevTools after checking. The lack of a linked identity is an actionable
provider setup state, not failure of the tabless GQL transport.

```js
(async () => {
  const cookie = await chrome.cookies.get({
    url: "https://www.twitch.tv", name: "auth-token"
  });
  if (!cookie?.value) return { sessionPresent: false };
  const query = `query TablessExtensionProbe($channelID: ID!) {
    user(id: $channelID) { channel { selfInstalledExtensions {
      installation { extension { id } activationConfig { state } }
      token { jwt }
    } } }
  }`;
  const results = [];
  for (const [provider, channelID, extensionID] of [
    ["nopixel", "136765278", "nstuq90nghenyqwqme61jgvmtp253a"],
    ["fortnite", "41245072", "x2nfeda4neuzvsp2zdqfln9nwxc7tp"]
  ]) {
    const response = await fetch("https://gql.twitch.tv/gql", {
      method: "POST", credentials: "omit",
      headers: {
        "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Content-Type": "application/json",
        Authorization: `OAuth ${cookie.value}`
      },
      body: JSON.stringify({ query, variables: { channelID } })
    });
    const body = await response.json();
    const row = body.data?.user?.channel?.selfInstalledExtensions?.find(
      row => row.installation?.extension?.id?.split(":")[0] === extensionID
    );
    let claims;
    try {
      claims = JSON.parse(atob(row.token.jwt.split(".")[1]
        .replace(/-/g, "+").replace(/_/g, "/")));
    } catch {}
    results.push({
      provider, httpStatus: response.status,
      gqlError: Boolean(body.errors?.length),
      installed: Boolean(row),
      active: row?.installation?.activationConfig?.state === "ACTIVE",
      tokenPresent: Boolean(row?.token?.jwt),
      authenticatedViewer: Boolean(claims?.opaque_user_id?.startsWith("U")),
      identityLinked: Boolean(claims?.user_id)
    });
  }
  return { sessionPresent: true, providers: results };
})()
```

Channel IDs above are the inspected buddha/loserfruit candidates; installation
changes may produce `installed: false` without implying an authentication bug.
Do not return `cookie`, `body`, `row` or `claims`, which contain credentials.
