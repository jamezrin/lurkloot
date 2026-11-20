export interface WebSocketMessageEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface WebSocketLike {
  send(data: string): void;
  // Hosts that can bound their close handshake may return its completion.
  close(): void | Promise<void>;
  readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
