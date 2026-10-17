import type { EventEmitter } from "@lurkloot/shared/events";
import type { KickAccountProgress } from "@lurkloot/shared/models";
import { errorMessage } from "@lurkloot/shared/errors";
import { diagnostic, type PageFetcher } from "../adapter";

// Kick's global viewer level and daily watch streak. Both are internal web
// endpoints read with the signed-in session, the same way kick.com's own chat
// identity card reads them; shapes confirmed against a live response.
export const KICK_LEVEL_URL = "https://web.kick.com/api/v1/gamification/user/level";
export const kickStreakUrl = (userId: string): string =>
  `https://web.kick.com/api/v1/gamification/users/${encodeURIComponent(userId)}/streak`;

interface KickLevelBody {
  level?: unknown;
  progress_xp?: unknown;
  xp_to_next_level?: unknown;
  user_id?: unknown;
}

// Kick wraps these in `data`; a bare body is accepted too, as elsewhere in this
// adapter, so an envelope change does not silently read as "no level".
function body<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  if (data && typeof data === "object") return data as T;
  return response as T;
}

function count(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : undefined;
}

export interface KickLevelRead {
  progress: Omit<KickAccountProgress, "streakDays">;
  userId?: string;
}

export function parseKickLevel(response: unknown): KickLevelRead | undefined {
  const level = body<KickLevelBody>(response);
  if (!level) return undefined;
  const value = count(level.level);
  const progressXp = count(level.progress_xp);
  const xpToNextLevel = count(level.xp_to_next_level);
  if (value === undefined || progressXp === undefined || xpToNextLevel === undefined) {
    return undefined;
  }
  const rawUserId = level.user_id;
  const userId =
    typeof rawUserId === "number" && Number.isFinite(rawUserId)
      ? String(rawUserId)
      : typeof rawUserId === "string" && rawUserId.trim()
        ? rawUserId.trim()
        : undefined;
  return {
    progress: { platform: "kick", level: value, progressXp, xpToNextLevel },
    ...(userId ? { userId } : {}),
  };
}

export function parseKickStreak(response: unknown): number | undefined {
  return count(body<{ length_days?: unknown }>(response)?.length_days);
}

// Reads the level, then the streak for the user the level belongs to. The level
// is the progress: without it this throws (or returns undefined on an unreadable
// body). The streak is optional, so its failure is reported and left out.
export async function fetchKickAccountProgress(
  fetcher: PageFetcher,
  { signal, emit }: { signal?: AbortSignal; emit: EventEmitter },
): Promise<KickAccountProgress | undefined> {
  const level = parseKickLevel(await fetcher.fetchJson<unknown>(KICK_LEVEL_URL, { signal }, emit));
  if (!level) {
    diagnostic(emit, "debug", "Kick level response had no readable level", "kick");
    return undefined;
  }
  if (!level.userId) return level.progress;
  try {
    const streakDays = parseKickStreak(
      await fetcher.fetchJson<unknown>(kickStreakUrl(level.userId), { signal }, emit),
    );
    return streakDays === undefined ? level.progress : { ...level.progress, streakDays };
  } catch (error) {
    signal?.throwIfAborted();
    diagnostic(emit, "debug", `Kick streak read failed: ${errorMessage(error)}`, "kick");
    return level.progress;
  }
}
