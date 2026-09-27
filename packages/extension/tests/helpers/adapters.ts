import { ignoreEvent, type PageFetcher } from "@lurkloot/core/adapter";
import { KickAdapter, type KickAdapterOptions } from "@lurkloot/core/kick";
import type { WebSocketFactory } from "@lurkloot/core/webSocket";
import type { TwitchIntegrityRequest } from "@lurkloot/core/tabRegistry";
import { TwitchAdapter, type TwitchAdapterOptions } from "@lurkloot/core/twitch";
import type { EventEmitter } from "@lurkloot/shared/events";
import { testCompatibility } from "./compatibility";

export const TWITCH_COMPAT = testCompatibility().twitch;
export const KICK_COMPAT = testCompatibility().kick;

// TwitchAdapterOptions/KickAdapterOptions require a resolved compatibility (see
// #360), so every construction site must supply one. These wrappers keep
// fixtures' existing call shapes (positional args, `undefined` placeholders for
// skipped middle ones) while resolving compatibility through the real resolver
// instead of restating a capability id by hand; a test that cares about a
// specific capability still overrides it via `options`.
export function twitchAdapter(
  fetcher: PageFetcher,
  ensureIntegrity?: (request?: TwitchIntegrityRequest) => Promise<boolean>,
  options?: Partial<TwitchAdapterOptions>,
  emit?: EventEmitter,
): TwitchAdapter {
  return new TwitchAdapter(
    fetcher,
    ensureIntegrity ?? (async () => false),
    // Strict availability is off in production (#400) but on here: these
    // fixtures were written against exact AvailableDrops validation and still
    // cover it. Tests for the default path pass `false` explicitly.
    { compatibility: TWITCH_COMPAT, strictCampaignAvailability: true, ...options },
    emit ?? ignoreEvent,
  );
}

export function kickAdapter(
  fetcher: PageFetcher,
  webSocketFactory?: WebSocketFactory,
  emit?: EventEmitter,
  options?: Partial<KickAdapterOptions>,
): KickAdapter {
  return new KickAdapter(
    fetcher,
    webSocketFactory,
    { compatibility: KICK_COMPAT, ...options },
    emit ?? ignoreEvent,
  );
}
