import type { PlatformCredentials } from "../authStore";
import type { TransportHandle } from "./common";

// Placeholder — the Playwright-backed browser transport is implemented in the
// next change. Declared here so the transport factory typechecks.
export async function createBrowserTransport(_credentials: PlatformCredentials, _authDir: string): Promise<TransportHandle> {
  throw new Error("The browser transport is not implemented yet.");
}
