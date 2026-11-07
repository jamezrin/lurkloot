import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneError,
  createControlPlaneClient,
  sessionTokenStore,
  TOKEN_STORAGE_KEY,
  type TokenPrompt,
} from "../src/api";
import { describeMessageError, isConnectionFailure } from "../src/errors";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A serve that wants `Bearer <token>` on every request, as a non-loopback
// bind does.
function guardedServe(token: string) {
  const seen: Array<string | undefined> = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    seen.push(authorization);
    return authorization === `Bearer ${token}`
      ? json(200, { result: { ok: true } })
      : json(401, { error: { code: "unauthorized", message: "A valid bearer token is required" } });
  });
  return { fetchImpl, seen };
}

describe("control plane client", () => {
  it("posts JSON same-origin and returns the parsed body", async () => {
    const fetchImpl = vi.fn(async () => json(200, { result: { settings: {}, state: {} } }));
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken: async () => null,
      fetchImpl,
    });

    await expect(
      client.request("POST", "/v1/session/messages", { type: "getSnapshot" }),
    ).resolves.toEqual({ result: { settings: {}, state: {} } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/session/messages");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.body).toBe('{"type":"getSnapshot"}');
  });

  it("turns serve's typed error body into a ControlPlaneError", async () => {
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken: async () => null,
      fetchImpl: async () =>
        json(400, {
          error: {
            code: "settings_unrepresentable",
            message: "Settings the CLI config cannot hold",
            paths: ["muteFarmingTabs"],
          },
        }),
    });

    const error = await client.request("POST", "/v1/session/messages", {}).catch((e) => e);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({
      status: 400,
      code: "settings_unrepresentable",
      paths: ["muteFarmingTabs"],
    });
  });

  it("reports a request that got no answer as network_error", async () => {
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken: async () => null,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const error = await client.request("GET", "/v1/session").catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
    expect(isConnectionFailure(error)).toBe(true);
  });

  it("asks for the token once on a 401, keeps it in sessionStorage and sends it as Bearer", async () => {
    sessionStorage.clear();
    const { fetchImpl, seen } = guardedServe("correct-token-0123456789");
    const promptToken = vi.fn<TokenPrompt>(async () => "correct-token-0123456789");
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken,
      fetchImpl,
    });

    await expect(client.request("GET", "/v1/session")).resolves.toEqual({ result: { ok: true } });
    await client.request("GET", "/v1/session");

    expect(promptToken).toHaveBeenCalledTimes(1);
    expect(promptToken).toHaveBeenCalledWith("required");
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("correct-token-0123456789");
    expect(localStorage.length).toBe(0);
    expect(seen).toEqual([
      undefined,
      "Bearer correct-token-0123456789",
      "Bearer correct-token-0123456789",
    ]);
  });

  it("shares one prompt between requests that meet a 401 together", async () => {
    sessionStorage.clear();
    const { fetchImpl } = guardedServe("correct-token-0123456789");
    let answer: (token: string) => void = () => undefined;
    const promptToken = vi.fn<TokenPrompt>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken,
      fetchImpl,
    });

    const requests = [
      client.request("GET", "/v1/session"),
      client.request("POST", "/v1/session/messages", { type: "getSnapshot" }),
      client.request("GET", "/v1/session/auth"),
    ];
    await vi.waitFor(() => expect(promptToken).toHaveBeenCalled());
    answer("correct-token-0123456789");

    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    expect(promptToken).toHaveBeenCalledTimes(1);
  });

  it("forgets a refused token and asks again, saying it was refused", async () => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "stale-token-0123456789");
    const { fetchImpl } = guardedServe("correct-token-0123456789");
    const promptToken = vi.fn<TokenPrompt>(async () => "correct-token-0123456789");
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken,
      fetchImpl,
    });

    await client.request("GET", "/v1/session");
    expect(promptToken).toHaveBeenCalledWith("rejected");
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("correct-token-0123456789");
  });

  it("keeps using the token in memory when sessionStorage refuses it", async () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    const { fetchImpl, seen } = guardedServe("correct-token-0123456789");
    const promptToken = vi.fn<TokenPrompt>(async () => "correct-token-0123456789");
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(refusing),
      promptToken,
      fetchImpl,
    });
    await client.request("GET", "/v1/session");
    await client.request("GET", "/v1/session");
    expect(promptToken).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe("Bearer correct-token-0123456789");
  });

  it("gives up with the 401 when the prompt is dismissed", async () => {
    sessionStorage.clear();
    const { fetchImpl } = guardedServe("correct-token-0123456789");
    const client = createControlPlaneClient({
      tokenStore: sessionTokenStore(sessionStorage),
      promptToken: async () => null,
      fetchImpl,
    });
    await expect(client.request("GET", "/v1/session")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("message errors", () => {
  const t = (key: string, substitutions?: string | string[]) =>
    substitutions ? `${key}(${[substitutions].flat().join("|")})` : key;
  const save = { type: "saveSettings", settingsPatch: {} } as const;

  it("names the settings paths serve refused", () => {
    expect(
      describeMessageError(
        new ControlPlaneError(400, "settings_unrepresentable", "x", [
          "muteFarmingTabs",
          "adFocusMode",
        ]),
        save,
        t,
      ),
    ).toBe("appErrorSettingsUnrepresentable(muteFarmingTabs, adFocusMode)");
    expect(
      describeMessageError(
        new ControlPlaneError(400, "settings_invalid", "x", ["schedulerIntervalMinutes"]),
        save,
        t,
      ),
    ).toBe("appErrorSettingsInvalid(schedulerIntervalMinutes)");
    expect(
      describeMessageError(new ControlPlaneError(503, "settings_unavailable", "x"), save, t),
    ).toBe("appErrorSettingsNotSaved");
  });

  it("stays quiet for a missed poll and for a lost connection, which has its own warning", () => {
    expect(
      describeMessageError(
        new ControlPlaneError(500, "internal_error", "x"),
        { type: "getSnapshot" },
        t,
      ),
    ).toBeUndefined();
    expect(
      describeMessageError(new ControlPlaneError(0, "network_error", "x"), save, t),
    ).toBeUndefined();
    expect(
      describeMessageError(new ControlPlaneError(502, "http_502", "Bad Gateway"), save, t),
    ).toBeUndefined();
    // serve's own typed 5xx is about the request, not the connection.
    expect(isConnectionFailure(new ControlPlaneError(503, "settings_unavailable", "x"))).toBe(
      false,
    );
  });
});
