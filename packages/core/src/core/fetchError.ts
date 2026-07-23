export type SafeFetchFailureKind =
  | "authentication_rejected"
  | "security_policy_blocked"
  | "http_error"
  | "invalid_response"
  | "network_error";

export interface SafeFetchFailure {
  kind: SafeFetchFailureKind;
  status?: number;
  reason?: string;
  reference?: string | number;
}

const FAILURE_KINDS = new Set<SafeFetchFailureKind>([
  "authentication_rejected",
  "security_policy_blocked",
  "http_error",
  "invalid_response",
  "network_error",
]);

export function safeFetchFailure(candidate: unknown): SafeFetchFailure {
  const value = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const kind = FAILURE_KINDS.has(value.kind as SafeFetchFailureKind)
    ? value.kind as SafeFetchFailureKind
    : "http_error";
  const failure: SafeFetchFailure = { kind };
  if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
    failure.status = value.status;
  }
  if (typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 256) {
    failure.reason = value.reason;
  }
  const reference = value.reference;
  if ((typeof reference === "string" && reference.length > 0 && reference.length <= 128)
    || (typeof reference === "number" && Number.isFinite(reference))) {
    failure.reference = reference;
  }
  return failure;
}

export class SafeFetchError extends Error {
  readonly failure: SafeFetchFailure;

  constructor(candidate: SafeFetchFailure) {
    const failure = safeFetchFailure(candidate);
    super([
      failure.status == null ? undefined : `HTTP ${failure.status}`,
      failure.reason,
    ].filter(Boolean).join(" ") || failure.kind);
    this.name = "SafeFetchError";
    this.failure = failure;
  }
}

export function isSafeFetchError(error: unknown): error is SafeFetchError {
  return error instanceof SafeFetchError;
}

export function authHealthFromError(
  error: unknown,
  checkedAt = new Date().toISOString(),
): PlatformAuthHealth | undefined {
  if (!isSafeFetchError(error)) return undefined;
  if (error.failure.kind === "authentication_rejected") {
    return {
      status: "invalid_credentials",
      checkedAt,
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };
  }
  if (error.failure.kind === "security_policy_blocked") {
    const reference = error.failure.reference;
    return {
      status: "blocked",
      checkedAt,
      reasonCode: "security_policy_blocked",
      message: {
        key: "authSecurityPolicyBlocked",
        ...(reference === undefined ? {} : { values: { reference } }),
      },
    };
  }
  return undefined;
}
import type { PlatformAuthHealth } from "@lurkloot/shared/models";
