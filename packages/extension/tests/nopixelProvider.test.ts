import { describe, expect, it, vi } from "vitest";
import { createNoPixelDriver } from "../src/extensions/nopixel/driver";
import type { DriverSession } from "../src/extensions/session";
const session: DriverSession = { jwt: "private", expiresAt: Date.now() + 3_600_000, channelId: "123", version: "1.1.2", identityLinked: true, signal: new AbortController().signal };
function setup() {
  let joined = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/ping")) return new Response(null, { status: 204 });
    if (url.endsWith("/channel/setup")) return Response.json({ is_channel_eligible_for_pack_giveaways: true, is_channel_eligible_for_watchtime_tracking: true, is_channel_connected_for_watchtime_tracking: true });
    if (url.endsWith("/progress")) return Response.json({ watch_time_earned: 10, watch_time_required: 60 });
    if (url.endsWith("/join")) { joined = true; return new Response(null, { status: 204 }); }
    return Response.json({ participants: [], has_user_entered_giveaway: joined });
  });
  return { fetcher, emit: vi.fn(), joined: vi.fn() };
}
describe("NoPixel tabless driver", () => {
  it("uses the published Bearer transport, joins and confirms server membership", async () => {
    const s = setup(); const driver = await createNoPixelDriver(s.fetcher, s.joined)(session, s.emit);
    expect(s.fetcher.mock.calls.every(([url, init]) => url.startsWith("https://nopixel.streamingtoolsmith.com/") && new Headers(init?.headers).get("Authorization") === "Bearer private")).toBe(true);
    expect(s.joined).toHaveBeenCalledOnce();
    expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "farming", progress: [{ key: "daily-pack", earned: 10, required: 60 }], pending: [{ key: "giveaway", state: "done" }] }));
    await driver.refresh!();
    expect(s.fetcher.mock.calls.filter(([url]) => url.endsWith("/join"))).toHaveLength(1);
    expect(JSON.stringify(s.emit.mock.calls)).not.toContain("private");
  });
  it("makes no provider request for an unlinked identity", async () => {
    const s = setup(); await createNoPixelDriver(s.fetcher)({ ...session, identityLinked: false }, s.emit);
    expect(s.fetcher).not.toHaveBeenCalled(); expect(s.emit).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "identity-required" }));
  });
  it("does not claim a join when the server still reports unentered", async () => {
    const s = setup(); const base = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (url, init) => url.endsWith("/giveaway") ? Response.json({ participants: [], has_user_entered_giveaway: false }) : base(url, init));
    const driver = await createNoPixelDriver(s.fetcher, s.joined)(session, s.emit);
    await driver.refresh!();
    expect(s.joined).not.toHaveBeenCalled();
    expect(s.fetcher.mock.calls.filter(([url]) => url.endsWith("/join"))).toHaveLength(1);
    expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ pending: [{ key: "giveaway", state: "open" }] }));
  });
  it("classifies auth/malformed responses without copying raw response data", async () => {
    const s = setup(); s.fetcher.mockImplementation(async () => new Response("private", { status: 401 }));
    await createNoPixelDriver(s.fetcher)(session, s.emit);
    expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: "auth-required" }));
    s.fetcher.mockImplementation(async () => Response.json({ token: "private" }));
    await createNoPixelDriver(s.fetcher)(session, s.emit);
    expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: "compatibility-error" }));
    expect(JSON.stringify(s.emit.mock.calls)).not.toContain("private");
  });
  it("stops requests and late results on cancellation", async () => {
    const s = setup(); const abort = new AbortController();
    const driver = await createNoPixelDriver(s.fetcher)({ ...session, signal: abort.signal }, s.emit);
    s.fetcher.mockClear(); s.emit.mockClear(); abort.abort();
    await driver.refresh!(); expect(s.fetcher).not.toHaveBeenCalled(); expect(s.emit).not.toHaveBeenCalled();
  });
});


it("retries a definitely rejected join after checking membership again", async () => {
  const s = setup(); const base = s.fetcher.getMockImplementation()!;
  let rejected = false;
  s.fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("/join") && !rejected) { rejected = true; return new Response(null, { status: 503 }); }
    return base(url, init);
  });
  const driver = await createNoPixelDriver(s.fetcher, s.joined)(session, s.emit);
  expect(s.joined).not.toHaveBeenCalled();
  await driver.refresh!();
  expect(s.joined).toHaveBeenCalledOnce();
  driver.stop();
});

it("releases daily farming on completion and does not join an ineligible channel", async () => {
  const s = setup(); const base = s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation(async (url, init) => {
    if (url.endsWith("/progress")) return Response.json({ watch_time_earned: 60, watch_time_required: 60 });
    if (url.endsWith("/channel/setup")) return Response.json({ is_channel_eligible_for_pack_giveaways: false, is_channel_eligible_for_watchtime_tracking: true, is_channel_connected_for_watchtime_tracking: true });
    return base(url, init);
  });
  const driver = await createNoPixelDriver(s.fetcher, s.joined)(session, s.emit);
  expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ status: "complete", reasonCode: "rewards-complete" }));
  expect(s.fetcher.mock.calls.some(([url]) => url.endsWith("/join"))).toBe(false);
  driver.stop();
});

it("reports a rejected endpoint and status without response bodies or authorization", async () => {
  const s = setup(); const base = s.fetcher.getMockImplementation()!;
  const diagnostic = vi.fn();
  s.fetcher.mockImplementation(async (url, init) => url.endsWith("/giveaway") ? new Response("private vendor details", { status: 404 }) : base(url, init));
  const driver = await createNoPixelDriver(s.fetcher, s.joined, Date.now, diagnostic)(session, s.emit);
  await driver.refresh!();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith("NoPixelV GET /channel/giveaway rejected: HTTP 404");
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private");
  expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: "provider-error" }));
  driver.stop();
});
