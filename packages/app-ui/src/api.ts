// The one HTTP client the app UI talks to `lurkloot serve` through. The popup
// adapter and the Accounts view both use it, so the access token is asked for,
// kept and sent in one place.
//
// Requests are relative (`/v1/...`): the app is served from the same origin as
// the control plane (by `serve` itself in #980, by the Vite dev proxy before
// that), which is what serve's Host and Origin checks expect.

// A failure the UI can describe: serve's typed error body, or a request that
// never got an answer (`network_error`, status 0).
export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  readonly paths?: readonly string[];

  constructor(status: number, code: string, message: string, paths?: readonly string[]) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
    if (paths) this.paths = paths;
  }
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
  return error instanceof ControlPlaneError;
}

// Where the access token lives between requests: sessionStorage in the app,
// so it is gone when the tab closes and never reaches localStorage.
export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

export const TOKEN_STORAGE_KEY = "lurkloot.app.serveToken";

export function sessionTokenStore(storage: Storage = sessionStorage): TokenStore {
  return {
    get: () => storage.getItem(TOKEN_STORAGE_KEY) ?? undefined,
    set: (token) => storage.setItem(TOKEN_STORAGE_KEY, token),
    clear: () => storage.removeItem(TOKEN_STORAGE_KEY),
  };
}

// Asks the user for the access token. "required" the first time serve answers
// 401, "rejected" when the token it was sent was refused. Resolves null when
// the user gives up.
export type TokenPrompt = (reason: "required" | "rejected") => Promise<string | null>;

export interface ControlPlaneClient {
  request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export function createControlPlaneClient(options: {
  tokenStore: TokenStore;
  promptToken: TokenPrompt;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): ControlPlaneClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? "";
  const { tokenStore } = options;
  // Every request that meets a 401 while the prompt is open waits on this one
  // prompt, so a poll, a save and a sign-in never stack dialogs.
  let pendingPrompt: Promise<string | null> | undefined;

  const askForToken = (reason: "required" | "rejected"): Promise<string | null> => {
    pendingPrompt ??= options.promptToken(reason).finally(() => {
      pendingPrompt = undefined;
    });
    return pendingPrompt;
  };

  const send = async (
    method: string,
    path: string,
    body: unknown,
    token: string | undefined,
  ): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        credentials: "omit",
      });
    } catch (error) {
      throw new ControlPlaneError(
        0,
        "network_error",
        error instanceof Error ? error.message : "The request failed",
      );
    }
  };

  return {
    async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
      for (;;) {
        const token = tokenStore.get();
        const response = await send(method, path, body, token);
        if (response.status === 401) {
          const current = tokenStore.get();
          // Another request already replaced the token this one was sent
          // with: try again with the new one before asking anybody.
          if (current && current !== token) continue;
          if (token) tokenStore.clear();
          const next = await askForToken(token ? "rejected" : "required");
          if (next === null) throw await errorFrom(response);
          tokenStore.set(next);
          continue;
        }
        if (!response.ok) throw await errorFrom(response);
        return (await response.json()) as T;
      }
    },
  };
}

async function errorFrom(response: Response): Promise<ControlPlaneError> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const error =
    parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error?: { code?: unknown; message?: unknown; paths?: unknown } }).error
      : undefined;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message =
    typeof error?.message === "string" ? error.message : response.statusText || "Request failed";
  const paths = Array.isArray(error?.paths)
    ? error.paths.filter((path): path is string => typeof path === "string")
    : undefined;
  return new ControlPlaneError(response.status, code, message, paths);
}
