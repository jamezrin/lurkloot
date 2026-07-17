// The three upsert sites in the workflows disagreed with each other: the authorization mint path
// picked the *first* matching comment while the read path decoded the *last*, so a duplicated
// marker would have minted into one comment and read from another. Every caller now resolves the
// same way — last match wins, matching the read side that authorization decisions depend on.
export function findByMarker(comments, marker) {
  return comments.filter((comment) => typeof comment.body === "string" && comment.body.includes(marker)).at(-1) ?? null;
}

export async function upsertComment(client, pr, { marker, body, comments }) {
  const existing = findByMarker(comments ?? await client.issueComments(pr), marker);
  if (existing) {
    await client.updateComment(existing.id, body);
    return { action: "updated", id: existing.id };
  }
  const created = await client.createComment(pr, body);
  return { action: "created", id: created?.id };
}

export async function ensureComment(client, pr, { marker, body, comments }) {
  const known = comments ?? await client.issueComments(pr);
  if (findByMarker(known, marker)) return { action: "skipped" };
  const created = await client.createComment(pr, body);
  return { action: "created", id: created?.id };
}
