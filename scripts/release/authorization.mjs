import { RELEASE_LABELS } from "./policy.mjs";

export const AUTHORIZATION_MARKER = "<!-- lurkloot-release-label-authorization:";
export const AUTHORIZATION_SCHEMA = 2;

const labelEvents = new Set(["labeled", "unlabeled"]);

export function recognizedReleaseLabels(labels) {
  return labels.filter((label) => RELEASE_LABELS.includes(label)).sort();
}

// The controller trusts one thing only: the most recent release-label event on the PR. Older
// events are history, not authorization.
export function latestReleaseLabelEvent(events) {
  const relevant = events.filter((event) =>
    labelEvents.has(event.event) && RELEASE_LABELS.includes(event.label?.name ?? ""));
  const latest = relevant.at(-1);
  if (!latest) return null;
  if (!Number.isInteger(latest.id) || latest.id <= 0) return null;
  return {
    id: latest.id,
    actor: latest.actor?.login ?? "",
    action: latest.event,
    label: latest.label.name,
  };
}

export function encodeAuthorization(record) {
  return `${AUTHORIZATION_MARKER}${Buffer.from(JSON.stringify(record)).toString("base64")} -->`;
}

export function decodeAuthorization(body) {
  if (typeof body !== "string" || !body.startsWith(AUTHORIZATION_MARKER)) return null;
  const encoded = body.slice(AUTHORIZATION_MARKER.length).replace(/\s*-->\s*$/, "").trim();
  try {
    const record = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return record?.schema === AUTHORIZATION_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

export function isAuthorizationComment(comment) {
  return comment?.user?.type === "Bot"
    && comment.user.login === "github-actions[bot]"
    && typeof comment.body === "string"
    && comment.body.startsWith(AUTHORIZATION_MARKER);
}

export function findAuthorizationComment(comments) {
  return comments.filter(isAuthorizationComment).at(-1) ?? null;
}

export function buildAuthorizationRecord({ pr, headSha, labels, authorizedBy, event, createdAt }) {
  return {
    schema: AUTHORIZATION_SCHEMA,
    pr,
    headSha,
    labels,
    authorizedBy,
    eventId: event.id,
    eventAction: event.action,
    eventLabel: event.label,
    createdAt,
  };
}

// A stored record only authorizes the PR while the label event it was minted for is still the
// newest one. Any later label change invalidates it, even if the resulting label set matches.
export function authorizationMatchesEvent(record, event) {
  if (!record || !event) return false;
  return record.schema === AUTHORIZATION_SCHEMA
    && record.eventId === event.id
    && record.eventAction === event.action
    && record.eventLabel === event.label;
}

export function authorizationMatchesSnapshot(record, { pr, headSha, labels }) {
  if (!record) return false;
  return record.schema === AUTHORIZATION_SCHEMA
    && record.pr === pr
    && record.headSha === headSha
    && Array.isArray(record.labels)
    && record.labels.length === labels.length
    && record.labels.every((label, index) => label === labels[index]);
}

// Mirrors the live label transition path: only an administrator acting on the newest release-label
// event may mint authorization, and the event must be the one that triggered this run.
export function deriveLabelEventAuthorization({ actorPermission, latestEvent, eventAction, eventActor, eventLabel }) {
  if (actorPermission !== "admin") {
    return { authorized: false, reason: "release label transition actor is not an administrator" };
  }
  if (!latestEvent) {
    return { authorized: false, reason: "no release label event found for this transition" };
  }
  if (latestEvent.actor !== eventActor || latestEvent.action !== eventAction || latestEvent.label !== eventLabel) {
    return { authorized: false, reason: "release label transition is not the newest label event" };
  }
  return { authorized: true, event: latestEvent };
}
