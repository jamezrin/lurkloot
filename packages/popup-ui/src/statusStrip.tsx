import React from "react";
import { Clock3, Eye, Gift, Pause, Power, Sparkles } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import { AutomationStatusLine, LINK_CLASS } from "./automation";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatMinutes, formatViewers } from "./format";
import { ImageWithFallback, Toggle, cn } from "./primitives";
import type { CampaignView, FarmingChannelView } from "./types";
import { campaignStats } from "./viewModels";

/** The strip above every view: what is being watched, how far it has got, which
 * source it came from, and the switch for this platform.
 *
 * While something is being watched it reads as two lines beside the campaign's
 * art — the campaign, then the channel and the reward being earned, with its
 * progress under them. Every other state keeps the one-line status and its call
 * to action. The strip has one fixed height in every steady state, so the
 * five-second poll can never resize it and shove the view under the pointer;
 * only a call to action may make it grow. */
export function StatusStrip({ platform, presentation, campaign, farmingChannel, supplementalName, onCampaignClick, onResume, sourceChip, enabled, pending, onToggle }: {
  platform: Platform;
  presentation: AutomationPresentation;
  campaign?: CampaignView;
  farmingChannel?: FarmingChannelView;
  // Set while a Twitch extension is the source being watched.
  supplementalName?: string;
  onCampaignClick?(): void;
  onResume?(): void;
  sourceChip?: React.ReactNode;
  enabled: boolean;
  pending: boolean;
  onToggle(value: boolean): void | Promise<void>;
}): React.ReactElement {
  const t = useT();
  const label = PLATFORMS[platform].label;
  const watching = presentation.state === "running" && farmingChannel ? farmingChannel : undefined;

  return (
    <div className="relative flex min-h-[58px] shrink-0 items-center gap-2.5 border-b border-zinc-200 bg-white px-3.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <StripLead campaign={watching ? campaign : undefined} presentation={presentation} enabled={enabled} watching={Boolean(watching)} supplemental={Boolean(supplementalName)} />
      <div className="min-w-0 flex-1">
        {watching ? (
          <WatchingLines campaign={campaign} channel={watching} supplementalName={supplementalName} onCampaignClick={onCampaignClick} />
        ) : (
          <div className="[&>div]:mt-0">
            <AutomationStatusLine platform={platform} presentation={presentation} onResume={onResume} />
          </div>
        )}
      </div>
      {sourceChip}
      <Toggle size="sm" checked={enabled} disabled={pending} onChange={onToggle} label={t("automationTitle", label)} />
    </div>
  );
}

function StripLead({ campaign, presentation, enabled, watching, supplemental }: { campaign?: CampaignView; presentation: AutomationPresentation; enabled: boolean; watching: boolean; supplemental: boolean }): React.ReactElement {
  if (campaign) {
    return (
      <div className="h-[34px] w-[34px] shrink-0 overflow-hidden rounded-lg">
        <ImageWithFallback src={campaign.imageUrl} alt="" fit="cover" fallback={
          <div className={cn("flex h-full w-full items-end bg-gradient-to-br p-1", campaign.tint)}>
            <span className="text-[10px] font-black leading-none text-white drop-shadow">{campaign.thumbnail}</span>
          </div>
        } />
      </div>
    );
  }
  const Icon = watching ? (supplemental ? Sparkles : Eye)
    : !enabled ? Power
    : presentation.state === "paused" ? Pause
    : Clock3;
  const live = watching || presentation.operational;
  return (
    <div className={cn(
      "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg",
      live ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
    )}
    >
      <Icon size={16} aria-hidden />
    </div>
  );
}

function WatchingLines({ campaign, channel, supplementalName, onCampaignClick }: {
  campaign?: CampaignView;
  channel: FarmingChannelView;
  supplementalName?: string;
  onCampaignClick?(): void;
}): React.ReactElement {
  const t = useT();
  const stats = campaign ? campaignStats(campaign) : undefined;
  const reward = stats && !stats.complete ? stats.nextReward : undefined;
  const rewardProgress = reward?.requirement === "watch" ? reward.progress ?? 0 : undefined;
  const title = campaign?.title ?? supplementalName ?? t("idleWatchlistTab");

  return (
    <div data-automation-state="running" className="min-w-0">
      <div className="flex min-w-0 items-center gap-1 text-[12.5px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
        {campaign && onCampaignClick ? (
          <button type="button" onClick={onCampaignClick} title={`${t("farmingLabel")} ${title}`} className="min-w-0 truncate text-start outline-none hover:text-[var(--accent-text)] focus-visible:text-[var(--accent-text)]">
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="shrink-0">{t("watchingLabel")}</span>
        {channel.url ? (
          <a href={channel.url} target="_blank" rel="noreferrer" className={cn(LINK_CLASS, "max-w-[9rem] shrink-0 text-[var(--accent-text)] dark:text-[var(--accent-text)]")}>{channel.name}</a>
        ) : (
          <span className="max-w-[9rem] shrink-0 truncate font-semibold text-zinc-800 dark:text-zinc-100">{channel.name}</span>
        )}
        {channel.viewers != null ? (
          <span className="shrink-0" title={t("viewerCount", formatViewers(channel.viewers))}>· {formatViewers(channel.viewers)}</span>
        ) : null}
        {reward ? (
          <span className="flex min-w-0 items-center gap-1">
            <span aria-hidden>·</span>
            <Gift size={10} aria-hidden className="shrink-0" style={{ color: "var(--accent-text)" }} />
            <span className="truncate">{reward.name}</span>
            {rewardProgress != null ? (
              <span className="shrink-0 tabular">· {formatMinutes((reward.requiredMinutes * rewardProgress) / 100)} / {formatMinutes(reward.requiredMinutes)}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {rewardProgress != null ? (
        <div className="mt-1 h-[3px] max-w-[260px] overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, rewardProgress)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
