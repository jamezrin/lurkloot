// Runs in the page's MAIN world. Twitch's player pauses the stream when it sees
// the tab go to the background (Page Visibility / focus), which stops drop watch
// time from accruing in our pinned background watch tab. This spoofs the
// visibility/focus state so the app believes the tab is always visible.
//
// It is gated on a shared DOM flag (`<html data-sm-keepalive="1">`) that the
// ISOLATED content script sets only for the extension's managed watch tab, so a
// user's own Twitch tabs keep pausing normally. Content-script worlds share DOM
// nodes but not JS realms, so the dataset attribute is the bridge between them.

const KEEP_ALIVE_ATTRIBUTE = "smKeepalive";

function keepAliveActive(): boolean {
  return document.documentElement?.dataset[KEEP_ALIVE_ATTRIBUTE] === "1";
}

function overrideDocumentGetter(property: string, spoofed: () => unknown): void {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, property)
    ?? Object.getOwnPropertyDescriptor(document, property);
  if (!original?.get) return;
  Object.defineProperty(document, property, {
    configurable: true,
    get() {
      return keepAliveActive() ? spoofed() : original.get!.call(this);
    },
  });
}

export function startVisibilityKeepAlive(): void {
  overrideDocumentGetter("hidden", () => false);
  overrideDocumentGetter("visibilityState", () => "visible");
  overrideDocumentGetter("webkitHidden", () => false);
  overrideDocumentGetter("webkitVisibilityState", () => "visible");

  const realHasFocus = document.hasFocus.bind(document);
  document.hasFocus = function hasFocus(): boolean {
    return keepAliveActive() ? true : realHasFocus();
  };

  // Stop the hidden/blur transitions from reaching Twitch's own handlers, while
  // the getters above keep reporting "visible" for anything that polls instead.
  const swallow = (event: Event) => {
    if (keepAliveActive()) event.stopImmediatePropagation();
  };
  for (const type of ["visibilitychange", "webkitvisibilitychange"]) {
    document.addEventListener(type, swallow, true);
  }
  for (const type of ["blur", "pagehide"]) {
    window.addEventListener(type, swallow, true);
  }
}
