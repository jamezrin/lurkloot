import type { ActivityEvent, DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";

// Activity entries are structured (code + data) and localized by the host UI,
// so on their own they are useless in a bug report: the reader gets a sentence
// in someone else's language with the ids and reason codes edited out. Every
// activity event therefore also produces a diagnostic that restates it in
// English and adds the context the sentence drops — campaign/reward ids, raw
// reason codes, claim method, session detail. Diagnostics stay the one surface
// a user can paste and a maintainer can grep.
//
// The wording here is deliberately literal English, never a catalog key: core
// has no i18n and must keep none.

function quoted(value: string): string {
  return `"${value}"`;
}

function target(data: { campaignId: string; campaignName: string; rewardId: string; rewardName: string }): string {
  return `${quoted(data.rewardName)} from campaign ${quoted(data.campaignName)} (campaign ${data.campaignId}, reward ${data.rewardId})`;
}

function describe(event: ActivityEvent): string {
  switch (event.code) {
    case "farming_started":
      return `Started farming ${target(event.data)}${event.data.channel ? ` on channel ${event.data.channel}` : ""}`;
    case "farming_stopped":
      return `Stopped farming ${target(event.data)}: reason=${event.data.reason}`;
    case "reward_claimed":
      return `Claimed ${target(event.data)} via ${event.data.method} claim`;
    case "interruption":
      return `Farming interrupted: reason=${event.data.reason}${event.data.detail ? ` (${event.data.detail})` : ""}`;
    case "challenge_claimed":
      return `Claimed ${event.data.rarity} ${event.data.recurrence} challenge ${event.data.challengeId}`;
    case "page_context_opened":
      return `Opened managed page context on ${event.data.host}: reason=${event.data.reason}`;
    case "page_context_closed":
      return `Closed managed page context on ${event.data.host}: reason=${event.data.reason}`;
    case "auth_health_changed":
      return `${event.platform} authentication health changed from ${event.data.from} to ${event.data.to}${event.data.reason ? `: reason=${event.data.reason}` : ""}`;
    case "critical_failure_detected":
      return `${event.platform} flagged as critically failing: reason=${event.data.reason}`;
    case "critical_failure_cleared":
      return `${event.platform} critical failure dismissed by the user, retrying: reason=${event.data.reason}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// The mirror keeps the activity event's level and platform so diagnostics-only
// views still surface errors, and carries `code`/`data` through so the entry
// stays machine-readable instead of only human-readable.
export function activityDiagnostic(event: ActivityEvent): DiagnosticEvent {
  return {
    category: "diagnostic",
    level: event.level,
    ...(event.platform ? { platform: event.platform } : {}),
    message: describe(event),
    code: event.code,
    mirroredActivity: true,
    data: { ...event.data },
  };
}

// Wraps an emitter so activity events are mirrored at the single choke point
// every emitter in the engine funnels through, instead of asking each emit site
// to remember a matching diagnostic. Hosts that keep diagnostics disabled drop
// the mirror when they filter by category, so this costs them no storage.
export function withActivityDiagnostics(emit: EventEmitter): EventEmitter {
  return (event: EngineEvent) => {
    // Stamp the moment of emission here: a host collects a tick's events and
    // writes them in one batch, so the write time can be many seconds later and
    // identical for events that happened far apart. An event that already
    // carries emittedAt (a replayed or host-synthesised one) keeps it.
    const emittedAt = event.emittedAt ?? new Date().toISOString();
    emit({ ...event, emittedAt });
    if (event.category === "activity") emit({ ...activityDiagnostic(event), emittedAt });
  };
}
