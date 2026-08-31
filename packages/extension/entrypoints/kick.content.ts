import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanelSpike } from "../src/core/inPagePanelSpike";

export default defineContentScript({
  matches: ["https://kick.com/*"],
  // Routes the panel's imported CSS into its shadow root instead of the page.
  cssInjectionMode: "ui",
  main(ctx) {
    startPlaybackTelemetry("kick");
    // SPIKE ONLY — remove with src/core/inPagePanelSpike.tsx.
    void mountInPagePanelSpike(ctx);
  },
});
