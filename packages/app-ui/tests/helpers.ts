import { vi } from "vitest";
import type { ControlPlaneClient } from "../src/api";
import { ControlPlaneError } from "../src/api";
import { handleFixtureRequest } from "../fixture/controlPlane";

/** A client answered by the dev fixture, which follows serve's shapes and
 * error codes, so tests run the app against a control plane without a CLI. */
export function fixtureClient(): ControlPlaneClient & {
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    request: vi.fn(async <T>(method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const answer = await handleFixtureRequest(method, path, body);
      if (answer.status >= 400) {
        const error = (
          answer.body as { error: { code: string; message: string; paths?: string[] } }
        ).error;
        throw new ControlPlaneError(answer.status, error.code, error.message, error.paths);
      }
      return answer.body as T;
    }) as ControlPlaneClient["request"],
  };
}
