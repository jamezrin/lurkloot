import type { Transport } from "../config";
import type { PlatformCredentials } from "../authStore";
import { createHttpTransport } from "./http";
import { createImpersonateTransport } from "./impersonate";
import type { EnabledPlatforms, TransportHandle } from "./common";

export type { TransportHandle, EnabledPlatforms } from "./common";

// Builds the adapter set for the configured transport. Returns a disposable
// handle so callers can release transport-owned resources. Async because the
// impersonate transport spins up a cycletls subprocess on creation; `http`
// resolves immediately.
export async function createTransport(
  transport: Transport,
  credentials: PlatformCredentials,
  _authDir: string,
  enabled: EnabledPlatforms,
): Promise<TransportHandle> {
  switch (transport) {
    case "http":
      return createHttpTransport(credentials, enabled);
    case "impersonate":
      return createImpersonateTransport(credentials, enabled);
    default:
      throw new Error(`Unknown transport: ${transport as string}`);
  }
}
