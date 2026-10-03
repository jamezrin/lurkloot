import type { Platform } from "@lurkloot/shared/models";

export class AuthProbeSetupError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
  ) {
    super(message);
    this.name = "AuthProbeSetupError";
  }
}
