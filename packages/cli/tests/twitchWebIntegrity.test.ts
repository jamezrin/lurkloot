import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildKasadaProof, decodeKasadaSaltCandidates, TwitchWebIntegrityManager } from "../src/auth/twitchWebIntegrity";

const packedSample = readFileSync(new URL("./fixtures/kasada-packed-sample.js", import.meta.url), "utf8");

describe("Kasada SDK proof", () => {
  it("decodes salt candidates from a packed SDK script", () => {
    expect(decodeKasadaSaltCandidates(packedSample)).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("follows the SDK's shuffled string tag rather than a fixed tag position", () => {
    const shuffled = packedSample
      .replace("if(f===a[3])", "if(f===a[5])")
      .replace("var y=[24,50,14,40,22,38]", "var y=[24,50,14,38,22,40]");
    expect(decodeKasadaSaltCandidates(shuffled)).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("rejects an SDK script whose packed layout changed", () => {
    expect(() => decodeKasadaSaltCandidates("window.KPSDK = {};")).toThrow(/SDK.*changed/i);
  });

  it("builds a fresh clearance-bound proof with the observed answer chain", () => {
    const proof = buildKasadaProof({
      clearanceToken: "3;1790696500000;abcdefghijklmnopqrstuv",
      salt: "a".repeat(64),
      workTime: 1790696500004,
      id: "1".repeat(32),
      st: 1790696500000,
      rst: 1790696500115,
    });
    expect(proof).toMatchObject({
      workTime: 1790696500004,
      id: "1".repeat(32),
      answers: [8, 3],
      st: 1790696500000,
      rst: 1790696500115,
      d: 115,
    });
    expect(proof.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("TwitchWebIntegrityManager", () => {
  it("validates a salt candidate against protected GQL and saves the rotated session cookie", async () => {
    const paths: string[] = [];
    const submittedProofs: Array<{ workTime: number; id: string; answers: number[] }> = [];
    const rotated: string[] = [];
    let mintCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/oauth2/validate") return Response.json({ client_id: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
      if (path.endsWith("/p.js")) return new Response(packedSample);
      if (path.endsWith("/fp")) {
        const headers = new Headers({ "x-kpsdk-ct": "3;1790696500000;abcdefghijklmnopqrstuv" });
        headers.append("set-cookie", "KP_UIDz-ssn=rotated-seed; Path=/; Secure; SameSite=None");
        headers.append("set-cookie", "KP_UIDz=3;1790696500000;abcdefghijklmnopqrstuv; Path=/; Secure; SameSite=None");
        return new Response("ok", { headers });
      }
      if (path === "/integrity") {
        const headers = new Headers(init?.headers);
        submittedProofs.push(JSON.parse(headers.get("x-kpsdk-cd") ?? "{}"));
        return Response.json({ token: `mint-${++mintCount}`, expiration: Date.now() + 60_000 });
      }
      if (path === "/gql") {
        const token = new Headers(init?.headers).get("client-integrity");
        return token === "mint-1"
          ? Response.json({ errors: [{ message: "failed integrity check" }] })
          : Response.json({ data: { currentUser: { dropCampaigns: [] } } });
      }
      throw new Error(`Unexpected request ${path}`);
    };
    const manager = new TwitchWebIntegrityManager({
      authToken: "web-token", deviceId: "device-id", kasadaSessionCookie: "initial-seed",
      fetcher, onSessionCookie: (value) => rotated.push(value),
    });

    expect(await manager.ensure()).toBe(true);
    expect(manager.current()).toMatchObject({ integrity: "mint-2", deviceId: "device-id" });
    expect(paths.filter((path) => path === "/integrity")).toHaveLength(2);
    expect(submittedProofs).toHaveLength(2);
    expect(submittedProofs[0]?.id).not.toBe(submittedProofs[1]?.id);
    expect(rotated).toEqual(["rotated-seed"]);
    expect(await manager.ensure()).toBe(true);
    expect(paths.filter((path) => path === "/integrity")).toHaveLength(2);
    expect(await manager.ensure({ forceRefresh: true, rejectedToken: "old-token" })).toBe(true);
    expect(paths.filter((path) => path === "/integrity")).toHaveLength(2);
    expect(await manager.ensure({ forceRefresh: true, rejectedToken: "mint-2" })).toBe(true);
    expect(manager.current()?.integrity).toBe("mint-3");
    expect(paths.filter((path) => path === "/integrity")).toHaveLength(3);
  });

  it("fails clearly when an imported web token has no Kasada session cookie", async () => {
    const manager = new TwitchWebIntegrityManager({ authToken: "web-token", deviceId: "device-id" });
    await expect(manager.ensure()).rejects.toThrow(/Kasada session cookie.*extension export/i);
  });

  it("backs off after a failed mint instead of repeating the SDK exchange on every call", async () => {
    let now = 1_000_000;
    let clearanceCalls = 0;
    let clearanceOk = false;
    const userAgents = new Set<string | null>();
    const manager = new TwitchWebIntegrityManager({
      authToken: "web-token", deviceId: "device-id", kasadaSessionCookie: "seed", now: () => now,
      fetcher: async (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/oauth2/validate") return Response.json({ client_id: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        userAgents.add(new Headers(init?.headers).get("user-agent"));
        if (path.endsWith("/p.js")) return new Response(packedSample);
        if (path.endsWith("/fp")) {
          clearanceCalls++;
          return clearanceOk ? new Response("ok", { headers: { "x-kpsdk-ct": "clearance" } }) : new Response("blocked", { status: 429 });
        }
        if (path === "/integrity") return Response.json({ token: "valid-token", expiration: Date.now() + 60_000 });
        if (path === "/gql") return Response.json({ data: { currentUser: { dropCampaigns: [] } } });
        throw new Error(`Unexpected request ${path}`);
      },
    });

    await expect(manager.ensure()).rejects.toThrow(/clearance failed: HTTP 429/);
    expect(await manager.ensure({ forceRefresh: true })).toBe(false);
    expect(clearanceCalls).toBe(1);

    now += 60_000;
    await expect(manager.ensure()).rejects.toThrow(/clearance failed/);
    expect(clearanceCalls).toBe(2);
    now += 60_000;
    expect(await manager.ensure()).toBe(false);
    expect(clearanceCalls).toBe(2);

    now += 60_000;
    clearanceOk = true;
    expect(await manager.ensure()).toBe(true);
    expect(clearanceCalls).toBe(3);
    expect([...userAgents]).toHaveLength(1);
    expect([...userAgents][0]).toMatch(/ Chrome\/\d+/);
    expect([...userAgents][0]).not.toMatch(/Headless/);
  });

  it("does not back off when every waiter cancelled the mint", async () => {
    const controller = new AbortController();
    let validations = 0;
    const manager = new TwitchWebIntegrityManager({
      authToken: "web-token", deviceId: "device-id", kasadaSessionCookie: "seed",
      fetcher: async (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/oauth2/validate") {
          validations++;
          if (validations === 1) {
            return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
          }
          return Response.json({ client_id: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        }
        if (path.endsWith("/p.js")) return new Response(packedSample);
        if (path.endsWith("/fp")) return new Response("ok", { headers: { "x-kpsdk-ct": "clearance" } });
        if (path === "/integrity") return Response.json({ token: "valid-token", expiration: Date.now() + 60_000 });
        if (path === "/gql") return Response.json({ data: { currentUser: { dropCampaigns: [] } } });
        throw new Error(`Unexpected request ${path}`);
      },
    });

    const cancelled = manager.ensure({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await manager.ensure()).toBe(true);
    expect(validations).toBe(2);
  });

  it("retries dashboard validation inline when the persisted hash expires", async () => {
    const queries: Record<string, unknown>[] = [];
    const manager = new TwitchWebIntegrityManager({
      authToken: "web-token", deviceId: "device-id", kasadaSessionCookie: "seed",
      fetcher: async (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/oauth2/validate") return Response.json({ client_id: "kimne78kx3ncx6brgo4mv6wki5h1ko" });
        if (path.endsWith("/p.js")) return new Response(packedSample);
        if (path.endsWith("/fp")) return new Response("ok", { headers: { "x-kpsdk-ct": "clearance" } });
        if (path === "/integrity") return Response.json({ token: "valid-token", expiration: Date.now() + 60_000 });
        if (path === "/gql") {
          queries.push(JSON.parse(String(init?.body)));
          return queries.length === 1
            ? Response.json({ errors: [{ message: "PersistedQueryNotFound" }] })
            : Response.json({ data: { currentUser: { dropCampaigns: [] } } });
        }
        throw new Error(`Unexpected request ${path}`);
      },
    });
    expect(await manager.ensure()).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1]?.query).toContain("query ViewerDropsDashboard");
  });

  it("lets one waiter abort without cancelling another shared mint", async () => {
    const first = new AbortController();
    let release!: (response: Response) => void;
    const validation = new Promise<Response>((resolve) => { release = resolve; });
    const manager = new TwitchWebIntegrityManager({
      authToken: "web-token", deviceId: "device-id", kasadaSessionCookie: "seed",
      fetcher: async (input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const path = new URL(input).pathname;
        if (path === "/oauth2/validate") return validation;
        if (path.endsWith("/p.js")) return new Response(packedSample);
        if (path.endsWith("/fp")) return new Response("ok", { headers: { "x-kpsdk-ct": "clearance" } });
        if (path === "/integrity") return Response.json({ token: "valid-token", expiration: Date.now() + 60_000 });
        if (path === "/gql") return Response.json({ data: { currentUser: { dropCampaigns: [] } } });
        throw new Error(`Unexpected request ${path}`);
      },
    });
    const aborted = manager.ensure({ signal: first.signal });
    const active = manager.ensure();
    first.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    release(Response.json({ client_id: "kimne78kx3ncx6brgo4mv6wki5h1ko" }));
    expect(await active).toBe(true);
  });
});
