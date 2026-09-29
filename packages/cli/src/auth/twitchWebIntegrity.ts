import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { integrityExpiry, type TwitchIntegrity, type TwitchIntegrityRequest } from "@lurkloot/core/twitchIntegrity";
import { TWITCH_DASHBOARD_QUERY } from "@lurkloot/core/twitch";

export interface KasadaProof {
  workTime: number;
  id: string;
  answers: number[];
  duration: number;
  d: number;
  st: number;
  rst: number;
}

export interface KasadaProofInput {
  clearanceToken: string;
  salt: string;
  workTime: number;
  id: string;
  st: number;
  rst: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// Twitch currently packs p.js with a small integer stream and one string pool.
// Decode just that pool: evaluating the remote script would run the whole SDK.
// If its packer changes, fail closed and report the drift to the CLI caller.
export function decodeKasadaSaltCandidates(source: string): string[] {
  if (source.length > 1_000_000) throw new Error("Twitch SDK packed layout changed (oversized script)");
  const encoded = source.match(/var H="([^"]+)";var c="length";var t=A\(H,"([^"]+)",(\d+)\)/);
  const tags = source.match(/var y=\[([0-9,]+)\];\{P\.V=/)?.[1].split(",").map(Number);
  const stringTagIndex = Number(source.match(/if\(f===a\[(\d+)\]\)\{if\(v!=null&&v\.V\)/)?.[1]);
  if (!encoded || !tags || tags.length !== 6 || !Number.isInteger(stringTagIndex) || stringTagIndex < 0 || stringTagIndex >= tags.length) {
    throw new Error("Twitch SDK packed layout changed");
  }

  const [, packed, alphabet, radixText] = encoded;
  const radix = Number(radixText);
  const base = alphabet.length - radix;
  if (radix <= 0 || base <= 0 || packed.length > 500_000) throw new Error("Twitch SDK packed layout changed");
  const codes = new Map([...alphabet].map((character, index) => [character, index]));
  const values: number[] = [];
  for (let offset = 0; offset < packed.length;) {
    let value = 0;
    let multiplier = 1;
    while (true) {
      if (offset >= packed.length) throw new Error("Twitch SDK packed layout changed (truncated stream)");
      const digit = codes.get(packed[offset++]);
      if (digit === undefined) throw new Error("Twitch SDK packed layout changed (unknown digit)");
      if (digit < radix) {
        value += multiplier * digit;
        values.push(value | 0);
        break;
      }
      value += multiplier * (digit % radix + radix);
      multiplier *= base;
      if (!Number.isSafeInteger(value) || !Number.isSafeInteger(multiplier)) {
        throw new Error("Twitch SDK packed layout changed (invalid integer)");
      }
    }
  }

  // The packer places its string pool in a final splice. `p = f + 4` because
  // `L` is still empty when `(L + true).length` is computed by the SDK.
  const size = values.length;
  const start = values[size - 1] ^ (size + 4);
  const length = values[start + 1];
  if (start < 0 || length <= 0 || length > 200_000 || start + length + 2 > size || values[start] !== tags[stringTagIndex]) {
    throw new Error("Twitch SDK packed layout changed (invalid string pool)");
  }
  let pool = "";
  for (let i = 0; i < length; i++) {
    const encodedCharacter = values[start + 2 + i];
    pool += String.fromCharCode((encodedCharacter & 0xffffffc0) | ((encodedCharacter * 41) & 63));
  }
  if (!pool.includes("tp-v2-input")) throw new Error("Twitch SDK proof scheme changed");

  const candidates = [...new Set([...pool.matchAll(/[0-9a-f]{64,}/g)]
    .flatMap((match) => Array.from({ length: match[0].length - 63 }, (_, index) => match[0].slice(index, index + 64))))];
  if (candidates.length === 0 || candidates.length > 12) throw new Error("Twitch SDK salt layout changed");
  return candidates;
}

export function buildKasadaProof(input: KasadaProofInput): KasadaProof {
  const started = performance.now();
  const { clearanceToken, salt, workTime, id, st, rst } = input;
  if (!clearanceToken || !/^[0-9a-f]{64}$/.test(salt) || !/^[0-9a-f]{32}$/.test(id)) {
    throw new Error("Cannot build Twitch SDK proof from invalid clearance, salt, or id");
  }
  let chain = sha256(`tp-v2-input${clearanceToken.slice(0, 16)}, ${workTime}, ${id}, ${salt}`);
  const answers: number[] = [];
  for (let round = 0; round < 2; round++) {
    let matched = false;
    for (let candidate = 1; candidate <= 100_000; candidate++) {
      const digest = sha256(`${candidate}, ${chain}`);
      const score = 16 ** 13 / (Number.parseInt(digest.slice(0, 13), 16) + 1);
      if (score < 5) continue;
      answers.push(candidate);
      chain = digest;
      matched = true;
      break;
    }
    if (!matched) throw new Error("Twitch SDK proof search exhausted");
  }
  return {
    workTime,
    id,
    answers,
    duration: Math.round((performance.now() - started) * 1000) / 1000,
    d: rst - st,
    st,
    rst,
  };
}

const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const SDK_BASE = "https://k.twitchcdn.net/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3";
const SDK_VERSION = "j-1.2.797";
const CLIENT_VERSION = "672c1fb4-8cec-4bfd-9af8-88bb8c1f5ad4";
const SDK_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36";
const EXPIRY_SKEW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface TwitchWebIntegrityOptions {
  authToken: string;
  deviceId: string;
  kasadaSessionCookie?: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  onSessionCookie?: (value: string) => void;
}

function jsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function expirationOf(response: { expiration?: number | string }, token: string): number {
  const raw = response.expiration;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return integrityExpiry(token);
}

export class TwitchWebIntegrityManager {
  private readonly fetcher: NonNullable<TwitchWebIntegrityOptions["fetcher"]>;
  private readonly sessionId = randomBytes(8).toString("hex");
  private sessionCookie?: string;
  private bundle?: TwitchIntegrity;
  private inFlight?: { promise: Promise<boolean>; controller: AbortController; waiters: number };

  constructor(private readonly options: TwitchWebIntegrityOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.sessionCookie = options.kasadaSessionCookie;
  }

  current(): TwitchIntegrity | undefined {
    return this.bundle && this.bundle.expiresAt - Date.now() > EXPIRY_SKEW_MS ? this.bundle : undefined;
  }

  async ensure(request: TwitchIntegrityRequest = {}): Promise<boolean> {
    request.signal?.throwIfAborted();
    const current = this.current();
    if (current && (!request.forceRefresh || (request.rejectedToken && request.rejectedToken !== current.integrity))) {
      request.onIntegrityCaptured?.(current);
      return true;
    }
    if (!this.inFlight) {
      const flight = { controller: new AbortController(), waiters: 0, promise: undefined as unknown as Promise<boolean> };
      flight.promise = this.mint(flight.controller.signal).finally(() => {
        if (this.inFlight === flight) this.inFlight = undefined;
      });
      this.inFlight = flight;
    }
    const flight = this.inFlight;
    flight.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = request.signal && new Promise<never>((_, reject) => {
        onAbort = () => reject(request.signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
      });
      const minted = await (aborted ? Promise.race([flight.promise, aborted]) : flight.promise);
      const updated = this.current();
      if (minted && updated) request.onIntegrityCaptured?.(updated);
      return Boolean(minted && updated);
    } finally {
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
      if (--flight.waiters === 0 && this.inFlight === flight) {
        flight.controller.abort();
        this.inFlight = undefined;
      }
    }
  }

  private fetchBounded(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    return this.fetcher(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  }

  private async mint(signal: AbortSignal): Promise<boolean> {
    const { authToken, deviceId } = this.options;
    if (!this.sessionCookie) {
      throw new Error("Twitch web integrity needs a Kasada session cookie from a new extension export");
    }
    if (!authToken || !deviceId) throw new Error("Twitch web integrity needs an OAuth token and device ID");

    const authorization = `OAuth ${authToken}`;
    const validation = await this.fetchBounded("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: authorization } }, signal);
    const identity = await jsonResponse<{ client_id?: string }>(validation, "Twitch OAuth validation");
    if (identity.client_id !== WEB_CLIENT_ID) throw new Error("Twitch OAuth token does not belong to the web client");

    const sdk = await this.fetchBounded(`${SDK_BASE}/p.js?x-kpsdk-v=${SDK_VERSION}`, {
      headers: { "User-Agent": SDK_USER_AGENT, Referer: "https://www.twitch.tv/" },
    }, signal);
    if (!sdk.ok) throw new Error(`Twitch SDK script failed: HTTP ${sdk.status}`);
    const salts = decodeKasadaSaltCandidates(await sdk.text());

    const fpStart = Date.now();
    const fp = await this.fetchBounded(`${SDK_BASE}/fp?x-kpsdk-v=${SDK_VERSION}`, {
      headers: {
        Cookie: `KP_UIDz-ssn=${this.sessionCookie}`,
        "User-Agent": SDK_USER_AGENT,
        Referer: "https://www.twitch.tv/",
        Origin: "https://www.twitch.tv",
      },
    }, signal);
    const fpEnd = Date.now();
    const clearanceToken = fp.headers.get("x-kpsdk-ct");
    if (!fp.ok || !clearanceToken) throw new Error(`Twitch SDK clearance failed: HTTP ${fp.status}`);
    const rotated = fp.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0])
      .find((pair) => pair.startsWith("KP_UIDz-ssn="))?.slice("KP_UIDz-ssn=".length);
    if (rotated && rotated !== this.sessionCookie) {
      this.sessionCookie = rotated;
      this.options.onSessionCookie?.(rotated);
    }

    const requestBase = {
      "Client-ID": WEB_CLIENT_ID,
      Authorization: authorization,
      "X-Device-Id": deviceId,
      "Client-Session-Id": this.sessionId,
      "Client-Version": CLIENT_VERSION,
      Origin: "https://www.twitch.tv",
      Referer: "https://www.twitch.tv/",
    };
    const dashboardQuery = {
      operationName: TWITCH_DASHBOARD_QUERY.operationName,
      variables: TWITCH_DASHBOARD_QUERY.variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: TWITCH_DASHBOARD_QUERY.sha256Hash } },
    };

    for (const salt of salts) {
      signal.throwIfAborted();
      const workTime = Date.now();
      const proof = buildKasadaProof({
        clearanceToken,
        salt,
        workTime,
        id: randomBytes(16).toString("hex"),
        st: fpStart,
        rst: fpEnd,
      });
      const mint = await this.fetchBounded("https://gql.twitch.tv/integrity", {
        method: "POST",
        headers: {
          ...requestBase,
          "Client-Request-Id": randomBytes(16).toString("hex"),
          "x-kpsdk-ct": clearanceToken,
          "x-kpsdk-cd": JSON.stringify(proof),
          "x-kpsdk-v": SDK_VERSION,
        },
      }, signal);
      const issued = await jsonResponse<{ token?: string; expiration?: number | string }>(mint, "Twitch integrity mint");
      if (!issued.token) continue;
      const token = issued.token;
      const checkDashboard = async (query: typeof dashboardQuery | { operationName: string; variables: typeof TWITCH_DASHBOARD_QUERY.variables; query: string }) => {
        const response = await this.fetchBounded("https://gql.twitch.tv/gql", {
          method: "POST",
          headers: {
            ...requestBase,
            "Client-Request-Id": randomBytes(16).toString("hex"),
            "Client-Integrity": token,
            "Content-Type": "text/plain;charset=UTF-8",
          },
          body: JSON.stringify(query),
        }, signal);
        if (!response.ok) throw new Error(`Twitch integrity validation failed: HTTP ${response.status}`);
        return response.json() as Promise<{ data?: { currentUser?: { dropCampaigns?: unknown[] } }; errors?: { message?: string }[] }>;
      };
      let checked = await checkDashboard(dashboardQuery);
      if (checked.errors?.some((error) => error.message === "PersistedQueryNotFound")) {
        checked = await checkDashboard({
          operationName: TWITCH_DASHBOARD_QUERY.operationName,
          variables: TWITCH_DASHBOARD_QUERY.variables,
          query: TWITCH_DASHBOARD_QUERY.inlineQuery,
        });
      }
      if (!Array.isArray(checked.data?.currentUser?.dropCampaigns) || checked.errors?.length) continue;
      this.bundle = {
        integrity: token,
        deviceId,
        clientSessionId: this.sessionId,
        expiresAt: expirationOf(issued, token),
      };
      return true;
    }
    throw new Error("Twitch rejected every browserless integrity proof from its current SDK");
  }
}
