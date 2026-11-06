import type { TokenPrompt } from "./api";

export interface TokenRequest {
  reason: "required" | "rejected";
  submit(token: string): void;
}

/** Connects the API client's token prompt to the React dialog. The client
 * asks through `prompt`; the app subscribes and shows the dialog while a
 * request is open. A prompt made before the app subscribes waits for it. */
export function createTokenPromptBridge(): {
  prompt: TokenPrompt;
  subscribe(listener: (request: TokenRequest | null) => void): () => void;
} {
  let current: TokenRequest | null = null;
  const listeners = new Set<(request: TokenRequest | null) => void>();
  const publish = () => {
    for (const listener of listeners) listener(current);
  };
  return {
    prompt: (reason) =>
      new Promise<string | null>((resolve) => {
        current = {
          reason,
          submit: (token) => {
            current = null;
            publish();
            resolve(token);
          },
        };
        publish();
      }),
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  };
}
