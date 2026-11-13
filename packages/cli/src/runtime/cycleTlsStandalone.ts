import type { CycleTLSClient } from "cycletls";
import { loadStandaloneCycleTls } from "./standalone";

// Stands in for the "cycletls" package in the standalone executable's bundle
// only (scripts/buildExecutable.mjs aliases it), so cycletls's GPL-3.0 code is
// never compiled into the executable. The package is loaded from the cycletls/
// folder beside the executable on first use, so commands that never start
// cycletls (--help, auth status) run without it. node dist/index.mjs and the
// Docker image import the real package as before.
export type { CycleTLSClient } from "cycletls";

export default function initCycleTLS(
  ...args: Parameters<ReturnType<typeof loadStandaloneCycleTls>>
): Promise<CycleTLSClient> {
  return loadStandaloneCycleTls()(...args);
}
