import type { BrowserTabApi } from "../../src/core/browserTabs";

export interface FakeTab {
  id: number;
  url: string;
  pinned: boolean;
  active: boolean;
  status: string;
  windowId: number;
  mutedInfo: { muted: boolean };
}

// A browser tab API with its own tab list, for running the extension's real tab
// ports (src/core/tabPorts.ts) in the controller contract suite (#598). It
// behaves like Chrome where the tab mechanics depend on it: a call on a missing
// tab rejects, and a removal fires onRemoved on a later microtask rather than
// inside the call, so the event can reach the controller before the tick that
// closed the tab commits (#640). It outlives a host restart, as real tabs do.
export class FakeBrowser implements BrowserTabApi {
  readonly tabList = new Map<number, FakeTab>();
  readonly removed: number[] = [];
  readonly scripted: unknown[] = [];
  private nextId = 100;
  private readonly removedListeners = new Set<(tabId: number) => void>();

  readonly tabs = {
    get: async (tabId: number): Promise<FakeTab> => ({ ...this.existing(tabId) }),
    update: async (tabId: number, properties: Record<string, unknown>): Promise<FakeTab> => {
      const tab = this.existing(tabId);
      if (typeof properties.url === "string") tab.url = properties.url;
      if (typeof properties.pinned === "boolean") tab.pinned = properties.pinned;
      if (typeof properties.active === "boolean") tab.active = properties.active;
      if (typeof properties.muted === "boolean") tab.mutedInfo = { muted: properties.muted };
      return { ...tab };
    },
    remove: async (tabId: number): Promise<void> => {
      this.existing(tabId);
      this.drop(tabId);
    },
    query: async (queryInfo: Record<string, unknown>): Promise<FakeTab[]> => {
      const pattern = typeof queryInfo.url === "string" ? queryInfo.url : undefined;
      return [...this.tabList.values()]
        .filter((tab) => pattern === undefined || matchesPattern(tab.url, pattern))
        .filter((tab) => typeof queryInfo.active !== "boolean" || tab.active === queryInfo.active)
        .map((tab) => ({ ...tab }));
    },
    create: async (properties: Record<string, unknown>): Promise<FakeTab> => {
      const tab: FakeTab = {
        id: this.nextId++,
        url: String(properties.url ?? "about:blank"),
        pinned: properties.pinned === true,
        active: properties.active === true,
        status: "complete",
        windowId: 1,
        mutedInfo: { muted: false },
      };
      this.tabList.set(tab.id, tab);
      return { ...tab };
    },
  };

  readonly scripting = {
    executeScript: async (details: unknown): Promise<Array<{ result?: unknown }>> => {
      this.scripted.push(details);
      return [{ result: undefined }];
    },
  };

  readonly windows = {
    update: async (): Promise<Record<string, never>> => ({}),
  };

  // The host's tabs.onRemoved subscription.
  onRemoved(listener: (tabId: number) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  // The user closes a tab: the browser removes it without the extension asking.
  userClose(tabId: number): void {
    this.existing(tabId);
    this.drop(tabId);
  }

  has(tabId: number): boolean {
    return this.tabList.has(tabId);
  }

  private existing(tabId: number): FakeTab {
    const tab = this.tabList.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }

  private drop(tabId: number): void {
    this.tabList.delete(tabId);
    this.removed.push(tabId);
    queueMicrotask(() => {
      for (const listener of this.removedListeners) listener(tabId);
    });
  }
}

// Chrome's match patterns as the tab mechanics use them: "<origin>/*".
function matchesPattern(url: string, pattern: string): boolean {
  return pattern.endsWith("/*") ? url.startsWith(pattern.slice(0, -1)) : url === pattern;
}
