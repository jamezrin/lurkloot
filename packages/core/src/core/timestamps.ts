// A self-written ISO timestamp can land in the future if the clock moves
// backwards after it was written (an NTP correction, a VM resuming from
// suspend, a user changing the system clock). Comparing it against `now`
// then yields a negative elapsed time, which passes almost any "is this
// recent enough" bound — so a value written before the jump reads as
// maximally fresh instead of maximally stale. Folding the unparseable and
// future cases into the same "stale" branch as the elapsed-time check keeps
// every caller from having to special-case them separately.
export function isTimestampStale(iso: string, maxAgeMs: number, now: number): boolean {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || parsed > now) return true;
  return now - parsed > maxAgeMs;
}

// Shared by the scheduler's playback-health check and the tab manager's
// re-priming check, which both judge the same `playback.checkedAt` stamp.
export const PLAYBACK_TELEMETRY_MAX_AGE_MS = 2 * 60 * 1000;
