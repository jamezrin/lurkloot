import { vi } from "vitest";
import { type CycleTlsClient, requestFrameOptions } from "../../src/transport/cycleTlsClient";

interface FakeCycleTlsAnswer {
  status: number;
  data?: unknown;
  headers?: Record<string, unknown>;
  finalUrl?: string;
}

export type FakeCycleTlsHandler = (
  url: string,
  // The options the client would send the binary in its request frame.
  options: any,
  method: string,
) => Promise<FakeCycleTlsAnswer> | FakeCycleTlsAnswer;

function bodyOf(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data ?? ""), "utf8");
}

function headersOf(headers: Record<string, unknown> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[name] = [value];
    else if (Array.isArray(value)) out[name] = value.map(String);
  }
  return out;
}

/**
 * A CycleTLS client that answers from a handler instead of the binary. The
 * handler sees each request's URL, frame options and method; `exit` is the
 * same spy as `close`.
 */
export function fakeCycleTls(
  handler: FakeCycleTlsHandler = () => ({ status: 200, data: {} }),
  close: () => Promise<void> = vi.fn(async () => undefined),
): CycleTlsClient & { exit: () => Promise<void> } {
  return {
    pid: undefined,
    port: 0,
    running: true,
    async request(options) {
      const answer = await handler(options.url, requestFrameOptions(options), options.method);
      return {
        status: answer.status,
        finalUrl: answer.finalUrl ?? "",
        headers: headersOf(answer.headers),
        body: bodyOf(answer.data),
      };
    },
    close,
    exit: close,
  };
}
