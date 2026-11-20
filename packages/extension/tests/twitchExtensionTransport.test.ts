import { describe, expect, it, vi } from "vitest";
import { createTwitchExtensionSessionSource } from "@lurkloot/core/extensions/host/transport";

describe("Twitch Extension session transport", () => {
  it.each(["kimne78kx3ncx6brgo4mv6wki5h1ko", "host-client-id"])(
    "sends GQL with the host's Client-ID (%s) and delegates authentication",
    async (clientId) => {
      const fetchJson = vi.fn(async (_url: string, _init: RequestInit) => ({ data: {} }));
      const source = createTwitchExtensionSessionSource({
        clientId,
        fetchJson,
        hasSession: async () => true,
      });
      await source.query("selected-channel-query", { channelID: "123" });
      const [url, init] = fetchJson.mock.calls[0];
      expect(url).toBe("https://gql.twitch.tv/gql");
      expect(JSON.parse(String(init.body))).toEqual({
        operationName: "CoordinatorExtensionsForChannel",
        query: "selected-channel-query",
        variables: { channelID: "123" },
      });
      expect(new Headers(init.headers).get("Client-ID")).toBe(clientId);
      expect(init.credentials).not.toBe("omit");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    },
  );
  it("bounds a transport that ignores abort and propagates parent cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal!: AbortSignal;
      const fetchJson = vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal!;
        return new Promise(() => {});
      });
      const source = createTwitchExtensionSessionSource({
        clientId: "host-client-id",
        fetchJson,
        hasSession: async () => true,
      });
      const abort = new AbortController();
      const pending = source.query("query", {}, abort.signal);
      const assertion = expect(pending).rejects.toThrow();
      abort.abort();
      await assertion;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
