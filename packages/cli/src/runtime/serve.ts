import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { LocalCredentialHealth } from "../authStore";
import { CLI_VERSION } from "../version";
import { buildSessionView, startControlPlane, type ServeBinding } from "./controlPlane";
import { runLoop, type FarmingController, type FarmingHost, type RunOptions } from "./run";

export interface ServeOptions extends Omit<RunOptions, "once" | "startHost"> {
  binding: ServeBinding;
  // The network-free credential reading `auth status` reports. Presence and
  // source only; never a credential value.
  describeCredentials: () => Record<Platform, LocalCredentialHealth>;
  // Called with the bound address once the control plane listens (port 0 in tests).
  onListening?: (address: { host: string; port: number }) => void;
}

// The control plane for one controller: messages go to handleMessage, and the
// session view is built from the snapshot and the local credential reading.
export async function startControllerControlPlane(
  controller: Pick<FarmingController, "handleMessage">,
  options: Pick<ServeOptions, "binding" | "describeCredentials" | "logger" | "onListening"> & {
    settingsWritable?: boolean;
  },
): Promise<FarmingHost> {
  const plane = await startControlPlane({
    ...options.binding,
    settingsWritable: options.settingsWritable ?? false,
    logger: options.logger,
    handleMessage: (message) => controller.handleMessage(message),
    describeSession: async () =>
      buildSessionView({
        version: CLI_VERSION,
        snapshot: (await controller.handleMessage({
          type: "getSnapshot",
        })) as RuntimeSnapshot<EngineSettings>,
        credentials: options.describeCredentials(),
      }),
  });
  options.onListening?.({ host: plane.host, port: plane.port });
  return plane;
}

// `lurkloot serve`: the `run` farming loop, plus the control plane started
// beside it and closed first on shutdown.
export function serveLoop(options: ServeOptions): Promise<void> {
  const { binding, describeCredentials, onListening, ...runOptions } = options;
  return runLoop({
    ...runOptions,
    startHost: (controller) =>
      startControllerControlPlane(controller, {
        binding,
        describeCredentials,
        logger: runOptions.logger,
        settingsWritable: Boolean(runOptions.settingsStore?.applyPatch),
        ...(onListening ? { onListening } : {}),
      }),
  });
}
