import { browser } from "wxt/browser";
import { bridgeSocketHost, type SocketHostPort } from "../../src/core/socketHost";

// The offscreen socket host's document: relays between the service worker
// and the Worker that owns the sockets (#792).
const worker = new Worker(new URL("../../src/core/socketHostWorker.ts", import.meta.url), { type: "module" });
bridgeSocketHost({
  connect: (name) => browser.runtime.connect({ name }) as unknown as SocketHostPort,
  worker,
});
