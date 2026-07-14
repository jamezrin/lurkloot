// Backwards-compatible exports for callers that used the original module.
export {
  buildMinuteWatchedEvent,
  buildSpadeInput,
  gzipBase64,
  SEND_SPADE_EVENTS_MUTATION,
} from "./heartbeat/gql-v1";
export type { MinuteWatchedContext } from "./heartbeat/gql-v1";
