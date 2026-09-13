import { describe, expect, it, vi } from "vitest";
import { discoverTwitchExtensionChannels } from "@lurkloot/core/extensions/discovery";
import { twitchExtensionProvider } from "@lurkloot/core/extensions/registry";
const provider = twitchExtensionProvider("nopixel")!;
describe("tabless extension directory discovery", () => {
  it("uses one bounded directory and one installation query, without acquiring viewer tokens", async () => {
    const query = vi.fn().mockResolvedValueOnce({ data: { game: { streams: { edges: [ { node: { id: "stream", viewersCount: 10, broadcaster: { id: "123", login: "buddha", displayName: "Buddha" } } }, { node: { id: "stream2", broadcaster: { id: "456", login: "excluded" } } } ] } } } }).mockResolvedValueOnce({ data: { users: [{ id: "123", login: "buddha", channel: { selfInstalledExtensions: [{ installation: { extension: { id: `${provider.extensionId}:1.1.2` }, activationConfig: { state: "ACTIVE" } } }] } }] } });
    expect(await discoverTwitchExtensionChannels({ provider, query, excludedChannels: ["excluded"] })).toMatchObject([{ username: "buddha", channelId: "123", categoryId: "32982" }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual({ logins: ["buddha"] });
    expect(query.mock.calls.map(call => call[0]).join(" ")).not.toMatch(/token|jwt/i);
  });
  it("rejects inactive or missing installations and suppresses malformed identifiers", async () => {
    const query = vi.fn().mockResolvedValueOnce({ data: { game: { streams: { edges: [{ node: { broadcaster: { id: "123", login: "valid" } } }, { node: { broadcaster: { id: "private-session", login: "invalid" } } }] } } } }).mockResolvedValueOnce({ data: { users: [{ id: "123", login: "valid", channel: { selfInstalledExtensions: [] } }] } });
    expect(await discoverTwitchExtensionChannels({ provider, query, excludedChannels: [] })).toEqual([]);
  });
});
