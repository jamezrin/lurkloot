# Richer activity log design

## Goal

Turn the popup's Activity tab from a timestamped text list into a concise,
visual event timeline. Every structured activity event receives intentional
iconography, hierarchy, and severity treatment. Drop-related entries also show
the obtained or farmed reward artwork and offer safe, clickable campaign links.

## Scope

This work changes the Activity tab only. The Diagnostics tab remains a plain,
English, copy-friendly troubleshooting surface, and the text export remains
plain text. No new browser permissions, network calls from the popup, or
credential handling are introduced.

## Event data

`CampaignRewardData` will gain optional immutable presentation metadata:

- `rewardImageUrl` — the parsed reward artwork URL, when the platform supplied
  one;
- `campaignUrl` — the parsed HTTPS campaign page URL, when available.

The controller and scheduler already have the complete `DropCampaign` and
`DropReward` objects when they emit farming lifecycle and reward-claimed
events. They will copy those two values into new activity entries. Persistence
therefore keeps a historical entry useful even when its campaign later expires
or disappears from the current snapshot. The fields remain optional so stored
legacy entries, platforms without image or page URLs, and external callers are
compatible.

No link metadata is fabricated for non-campaign events. Their cards use only
the structured event data that is already safe to display.

## Presentation model

`packages/popup-ui/src/activity.logic.ts` will expose a small, typed view-model
builder for activity records. It retains `formatActivityEvent` as the
localized, accessible summary and adds card-specific fields:

- an event-family icon and accent treatment;
- a localized label/headline and optional supporting detail;
- optional reward art and campaign link for campaign/reward events;
- reason, claim method, recurrence, host, or auth transition chips where that
  data helps distinguish the event;
- a fallback initial/icon when artwork is absent or cannot load.

The builder handles every `ActivityEvent["code"]` exhaustively:

| Event family | Card treatment |
| --- | --- |
| `farming_started`, `farming_stopped`, `reward_claimed` | Reward artwork or fallback tile, campaign/reward hierarchy, event icon, severity stripe, campaign action when the event has a safe URL. |
| `challenge_claimed` | Trophy card with rarity and recurrence chips. |
| `interruption` | Alert card with localized reason and optional diagnostic detail. |
| `page_context_opened`, `page_context_closed` | Context lifecycle card with host and reason chip. |
| `auth_health_changed` | Shield/status card showing the localized status transition and optional reason. |
| `critical_failure_detected`, `critical_failure_cleared` | Clearly differentiated critical-health cards, preserving the existing severity semantics. |

`ActivityLog` will render the timeline cards through focused presentational
components, reusing `ImageWithFallback`, existing platform accents, Lucide
icons, and the existing `openHttpsLink` host boundary. The campaign action
will call the popup runtime's `openLink` only after that helper accepts an
HTTPS URL. Link controls will have an accessible label and will not be nested
inside another interactive element.

Legacy activity records and any event without optional metadata render the
same card family with a generated fallback tile and no action. Diagnostics and
unknown legacy records retain their current compact text row in the separate
Diagnostics view.

## Visual and accessibility requirements

Cards remain compact enough for the extension popup, but replace the single
text row with a readable title/detail layout. Color supplements, never
replaces, icon and text meaning. Artwork has informative reward alt text;
decorative icons are hidden from assistive technology. Long titles, hostnames,
and detail text wrap without forcing horizontal overflow. The layout supports
both light/dark modes and existing RTL behavior.

## Testing

Focused tests will prove:

- core/controller and scheduler emissions preserve available reward artwork and
  campaign URLs without changing diagnostic mirrors;
- each structured activity code gets a card model and stable fallback behavior;
- reward cards render image, localized text, metadata, and an HTTPS-only
  campaign action;
- missing/broken artwork and legacy activity entries render safely without an
  invalid image or action;
- operational cards distinguish reason/status data while diagnostics remain
  raw;
- copy/export behavior stays localized plain text.

The extension suite and workspace typecheck provide final verification.
