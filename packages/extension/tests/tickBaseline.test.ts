import { afterEach, describe, expect, it, vi } from "vitest";
import { createCountingAdapter, createTickBaselineRecorder } from "./helpers/tickBaseline";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler tick baseline recorder", () => {
  it("records aggregate work without credential or payload fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const recorder = createTickBaselineRecorder();

    recorder.count("providerRequests");
    await recorder.clock.advance("discovery", 40);

    expect(recorder.snapshot()).toEqual({
      counts: {
        providerRequests: 1,
        campaignDiscovery: 0,
        candidateListings: 0,
        channelChecks: 0,
        campaignsEvaluated: 0,
        candidatesEvaluated: 0,
        watcherReconciliations: 0,
        heartbeats: 0,
        adapterConstructions: 0,
        settingsLoads: 0,
        stateLoads: 0,
        stateSaves: 0,
        eventPublications: 0,
      },
      durationsMs: {
        discovery: 40,
        selection: 0,
        watcher: 0,
        persistence: 0,
        total: 40,
      },
    });
    expect(JSON.stringify(recorder.snapshot())).not.toMatch(
      /credential|cookie|token|authorization|payload/i,
    );
  });

  it.each(["twitch", "kick"] as const)("counts normalized %s provider work", async (platform) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T20:00:00.000Z");
    const recorder = createTickBaselineRecorder();
    const adapter = createCountingAdapter(platform, "refresh", recorder);

    const campaigns = await adapter.refreshCampaigns();
    const candidates = await adapter.listCandidateChannels(campaigns[0]);
    const checked = await adapter.checkChannel(candidates[0]);

    expect(campaigns).toHaveLength(1);
    expect(checked).toMatchObject({ live: true, categoryMatches: true });
    expect(recorder.snapshot()).toMatchObject({
      counts: {
        providerRequests: 3,
        campaignDiscovery: 1,
        candidateListings: 1,
        channelChecks: 1,
      },
      durationsMs: { discovery: 30, selection: 20, total: 50 },
    });
  });
});
