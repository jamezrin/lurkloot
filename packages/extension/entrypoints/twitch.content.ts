import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanelSpike } from "../src/core/inPagePanelSpike";

export default defineContentScript({
  matches: ["https://www.twitch.tv/*"],
  main() {
    startPlaybackTelemetry("twitch");
    // SPIKE ONLY — remove with src/core/inPagePanelSpike.ts.
    mountInPagePanelSpike();
  },
});
