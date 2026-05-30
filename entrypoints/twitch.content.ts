import { startPlaybackTelemetry } from "../src/core/playbackContent";

export default defineContentScript({
  matches: ["https://www.twitch.tv/*"],
  main() {
    startPlaybackTelemetry("twitch");
  },
});
