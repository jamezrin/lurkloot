import { startPlaybackTelemetry } from "../src/core/playbackContent";

export default defineContentScript({
  matches: ["https://kick.com/*"],
  main() {
    startPlaybackTelemetry("kick");
  },
});
