export interface WebSocketMessageEventLike {
  data?: unknown;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
