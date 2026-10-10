import { KICK_REALTIME_RELAY_URL, startKickRealtimeRelay } from "../src/core/kickRealtimeRelay";

// Runs only in the kick.com frame inside our own offscreen document, never in
// a tab: it relays the worker's Kick realtime sockets so their handshake
// carries kick.com's origin (#754).
export default defineContentScript({
  matches: [KICK_REALTIME_RELAY_URL],
  allFrames: true,
  runAt: "document_start",
  exclude: ["firefox"],
  main() {
    const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
    startKickRealtimeRelay({
      connect: (name) => browser.runtime.connect({ name }) as never,
      createWebSocket: (url) => new WebSocket(url),
      isRelayFrame: window.top !== window && location.ancestorOrigins?.[0] === extensionOrigin,
    });
  },
});
