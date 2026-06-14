import type { Transport } from "../config";
import type { PlatformCredentials } from "../authStore";
import { createHttpTransport } from "./http";
import { createImpersonateTransport } from "./impersonate";
import { createBrowserTransport } from "./browser";
import type { TransportHandle } from "./common";

export type { TransportHandle } from "./common";

// Builds the adapter set for the configured transport. Returns a disposable
// handle so callers can release transport-owned resources (cycletls/Playwright).
export async function createTransport(transport: Transport, credentials: PlatformCredentials, authDir: string): Promise<TransportHandle> {
  switch (transport) {
    case "http":
      return createHttpTransport(credentials);
    case "impersonate":
      return createImpersonateTransport(credentials);
    case "browser":
      return createBrowserTransport(credentials, authDir);
    default:
      throw new Error(`Unknown transport: ${transport as string}`);
  }
}
