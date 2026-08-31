import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanelSpike } from "../src/core/inPagePanelSpike";

export default defineContentScript({
  matches: ["https://kick.com/*"],
  main() {
    startPlaybackTelemetry("kick");
    // SPIKE ONLY — remove with src/core/inPagePanelSpike.ts.
    mountInPagePanelSpike();
  },
});
