import { hashEnglish } from "./hash.ts";

export function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectStringLeaves(nested, out);
  }
  return out;
}

export function applyStringLeaves<T>(value: T, leaves: string[], index?: { i: number }): T {
  const tracker = index ?? { i: 0 };
  let result: T;
  if (typeof value === "string") {
    const next = leaves[tracker.i];
    if (next === undefined) throw new Error("Translation leaf count is shorter than the English tree");
    tracker.i += 1;
    result = next as T;
  } else if (Array.isArray(value)) {
    result = value.map((item) => applyStringLeaves(item, leaves, tracker)) as T;
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      applyStringLeaves(nested, leaves, tracker),
    ]);
    result = Object.fromEntries(entries) as T;
  } else {
    result = value;
  }
  if (!index && tracker.i !== leaves.length) {
    throw new Error("Translation leaf count is longer than the English tree");
  }
  return result;
}

export function translationId(text: string): string {
  return hashEnglish(text);
}
