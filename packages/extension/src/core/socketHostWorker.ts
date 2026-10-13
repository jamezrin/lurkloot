import { startSocketWorker, type SocketHostEvent, type SocketWorkerControl } from "./socketHost";

// The Worker the socket host document spawns: it owns the platform sockets
// (#792).
const scope = self as unknown as {
  postMessage(message: SocketHostEvent): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};
const handle = startSocketWorker({
  post: (event) => scope.postMessage(event),
  createWebSocket: (url) => new WebSocket(url),
});
scope.addEventListener("message", (event) => handle(event.data as SocketWorkerControl));
