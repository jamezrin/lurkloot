import type { EngineSettings } from "@lurkloot/shared/models";
import type { BackgroundHostPorts, SupplementalSourcesPort } from "./hostPorts";
import type { TickEffectExecutor } from "./tickEffects";
import type { ControllerCalls } from "./types";

// The scheduler's supplemental target selection (#591), performed through the
// host's supplemental-sources port (Twitch Extensions on the extension). Only
// Twitch has such sources; without the port nothing is selected.
export function registerSupplementalTargetEffect<S extends EngineSettings>(
  executor: TickEffectExecutor,
  sources: SupplementalSourcesPort<S> | undefined,
): TickEffectExecutor {
  return executor.register("selectSupplementalTarget", async ({ platform, state, source }, context) =>
    platform === "twitch" && sources
      ? await sources.select(state, context.settings as S, context.signal, source)
      : undefined);
}

// The owner of the supplemental-sources port: it registers the one handler that
// uses it, so the tick coordinator never touches the Twitch-only port itself.
export function createSupplementalSources<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
): Pick<ControllerCalls<S>, "registerSupplementalTargetEffects"> {
  return {
    registerSupplementalTargetEffects: (executor) =>
      registerSupplementalTargetEffect(executor, ports.twitch.supplementalSources),
  };
}
