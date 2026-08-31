import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanel } from "../src/core/inPagePanel";

export default defineContentScript({
  matches: ["https://kick.com/*"],
  // Routes the panel's imported CSS into its shadow root instead of the page.
  cssInjectionMode: "ui",
  main(ctx) {
    startPlaybackTelemetry("kick");
    void mountInPagePanel(ctx);
  },
});
