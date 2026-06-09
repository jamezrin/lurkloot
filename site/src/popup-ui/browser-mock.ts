// Site-only stand-in for `wxt/browser`. The Astro build aliases `wxt/browser`
// to this module, so when the imported popup (`entrypoints/popup/app.tsx`) does
// `import { browser } from "wxt/browser"`, it resolves here.
//
// Two jobs:
//  1. Set the demo config on globalThis BEFORE app.tsx's body evaluates. Because
//     app.tsx imports `wxt/browser` at its top, this module runs first — so the
//     `__STREAM_AUTOPILOT_DEMO__` global is in place when app.tsx reads it.
//  2. Provide a no-op `browser` surface so the popup runs with mock data and
//     never touches a real extension/background.

declare global {
  // eslint-disable-next-line no-var
  var __STREAM_AUTOPILOT_DEMO__:
    | { enabled: boolean; locale?: string | null; variant?: string; version?: string }
    | undefined;
}

globalThis.__STREAM_AUTOPILOT_DEMO__ ??= {
  enabled: true,
  locale: "en",
  variant: "twitch-drops",
  version: "1.0.0",
};

// In-memory storage so UI state (selected platform, collapsed sections) persists
// while the visitor clicks around, without any extension storage.
const store: Record<string, unknown> = {};

export const browser = {
  i18n: {
    getMessage: () => "",
    getUILanguage: () => "en",
  },
  runtime: {
    getURL: (path: string) => path,
    getManifest: () => ({ version: "1.0.0" }),
    connect: () => ({
      disconnect() {},
      postMessage() {},
      onMessage: { addListener() {}, removeListener() {} },
      onDisconnect: { addListener() {}, removeListener() {} },
    }),
    sendMessage: async () => ({}),
  },
  storage: {
    local: {
      get: async (keys?: string | string[]) => {
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]));
        return { ...store };
      },
      set: async (values: Record<string, unknown>) => {
        Object.assign(store, values);
      },
    },
  },
};
