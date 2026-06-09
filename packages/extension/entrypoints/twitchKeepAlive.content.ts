import { startVisibilityKeepAlive } from "../src/core/keepAliveContent";

export default defineContentScript({
  matches: ["https://www.twitch.tv/*"],
  // MAIN world so the overrides apply to Twitch's own player code, and at
  // document_start so they are in place before Twitch reads visibility.
  world: "MAIN",
  runAt: "document_start",
  main() {
    startVisibilityKeepAlive();
  },
});
