import React, { useEffect, useMemo, useState } from "react";
import { useT } from "./context";
import { ViewToolbar } from "./viewToolbar";
import { CampaignCard } from "./drops";
import { fallbackGame } from "./viewModels";
import type { CampaignView, GameItem } from "./types";
import { EmptyPanel } from "./primitives";
import { Segmented } from "./controls";

type CompletedTab = "finished" | "expired";

/** Campaigns that are over, kept out of the queue and out of the ranking.
 *
 * Each row carries exactly one terminal state (#569): no progress, no rank, no
 * drag handle, no "Later" pill and no farming-rejection warning — a finished
 * campaign is not waiting for anything, so nothing here may suggest it is.
 * Rewards still expand, which is the reason to come back to this view at all. */
export function CompletedPanel({ campaigns, gameMap, focus, refreshing, onRefreshCampaign }: {
  campaigns: CampaignView[];
  gameMap: Record<string, GameItem>;
  focus?: { id: string; seq: number } | null;
  refreshing: boolean;
  onRefreshCampaign(id: string): void | Promise<void>;
}): React.ReactElement {
  const t = useT();
  const [tab, setTab] = useState<CompletedTab>("finished");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const finished = useMemo(() => campaigns.filter((campaign) => campaign.section === "completed"), [campaigns]);
  const expired = useMemo(() => campaigns.filter((campaign) => campaign.section === "expired"), [campaigns]);
  const rows = tab === "finished" ? finished : expired;

  // A focus request can name a campaign in either list (the status strip links
  // to a campaign that may have finished since), so follow it to its tab.
  useEffect(() => {
    if (!focus) return;
    if (expired.some((campaign) => campaign.id === focus.id)) setTab("expired");
    else if (finished.some((campaign) => campaign.id === focus.id)) setTab("finished");
    setExpandedIds((current) => ({ ...current, [focus.id]: true }));
  }, [focus?.id, focus?.seq]);

  return (
    <section className="space-y-1.5">
      <ViewToolbar>
      <Segmented<CompletedTab>
        label={t("navCompleted")}
        value={tab}
        itemAttribute="data-completed-tab"
        options={([["finished", finished.length], ["expired", expired.length]] as const).map(([value, count]) => ({
          value,
          label: t(value === "finished" ? "completedTabFinished" : "completedTabExpired"),
          count,
        }))}
        onChange={(value: CompletedTab) => setTab(value)}
      />
      </ViewToolbar>

      {rows.length === 0 ? (
        <EmptyPanel>{t(tab === "finished" ? "completedEmptyFinished" : "completedEmptyExpired")}</EmptyPanel>
      ) : (
        <div data-queue-group={tab} className="space-y-1">
          {rows.map((campaign, index) => (
            <div key={campaign.id} data-campaign-id={campaign.id}>
              <CampaignCard
                campaign={campaign}
                index={index}
                farmingIndex={-1}
                anyFarming={false}
                game={gameMap[campaign.gameId] ?? fallbackGame(campaign, index, t)}
                expanded={Boolean(expandedIds[campaign.id])}
                refreshing={refreshing}
                onToggle={() => setExpandedIds((current) => ({ ...current, [campaign.id]: !current[campaign.id] }))}
                onRefreshCampaign={onRefreshCampaign}
                terminal
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
