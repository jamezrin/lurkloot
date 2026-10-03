// The background answers a runtime message whose handler threw with this
// envelope, because `sendResponse` can't carry a rejection across the message
// channel. Callers must see it as the failure it is, not as a response.
export const REQUEST_FAILED_RESPONSE = { error: "request-failed" } as const;

export class RuntimeRequestError extends Error {
  constructor(readonly messageType: string) {
    super(`Background request failed: ${messageType}`);
    this.name = "RuntimeRequestError";
  }
}

function isRequestFailedResponse(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && (value as { error?: unknown }).error === REQUEST_FAILED_RESPONSE.error;
}

// Wraps `browser.runtime.sendMessage` so a failed handler rejects, the same
// contract as the site demo adapter, and every caller's `catch` runs.
export function createRuntimeRequestSender(
  sendMessage: (message: unknown) => Promise<unknown>,
): <T>(message: { type: string }) => Promise<T> {
  return async <T>(message: { type: string }) => {
    const response = await sendMessage(message);
    if (isRequestFailedResponse(response)) throw new RuntimeRequestError(message.type);
    return response as T;
  };
}
