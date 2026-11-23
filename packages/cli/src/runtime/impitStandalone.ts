import type { Impit as ImpitClient, ImpitOptions } from "impit";
import { loadStandaloneImpit } from "./standalone";

// Stands in for the "impit" package in the standalone executable's bundle only
// (scripts/buildExecutable.mjs aliases it). impit's native add-on cannot be
// loaded from inside the executable, so the package is loaded from the impit/
// folder beside it, on the first client built, and commands that never build
// one (--help, auth status, the cycletls and http transports) run without the
// folder. node dist/index.mjs and the Docker image import the real package.
export type { ImpitOptions } from "impit";

export const Impit = function Impit(options?: ImpitOptions): ImpitClient {
  const { Impit: Loaded } = loadStandaloneImpit();
  return new Loaded(options);
} as unknown as new (
  options?: ImpitOptions,
) => ImpitClient;
