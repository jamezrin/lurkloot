import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { LocalCredentialHealth } from "../authStore";
import { CLI_VERSION } from "../version";
import { errorMessage } from "@lurkloot/shared/errors";
import {
  buildSessionView,
  startControlPlane,
  type ControlPlane,
  type ServeBinding,
} from "./controlPlane";
import { createAuthFlows, createAuthRoutes, type AuthFlowsOptions } from "./controlPlaneAuth";
import { runLoop, type FarmingController, type FarmingHost, type RunOptions } from "./run";

export interface ServeOptions extends Omit<RunOptions, "once" | "startHost"> {
  binding: ServeBinding;
  // The network-free credential reading `auth status` reports. Presence and
  // source only; never a credential value.
  describeCredentials: () => Record<Platform, LocalCredentialHealth>;
  // Called with the bound address once the control plane listens (port 0 in tests).
  onListening?: (address: { host: string; port: number }) => void;
  // Enables the sign-in routes (controlPlaneAuth.ts) against this auth store.
  auth?: Omit<AuthFlowsOptions, "logger" | "onCredentialsChanged">;
}

// The control plane for one controller: messages go to handleMessage, and the
// session view is built from the snapshot and the local credential reading.
export async function startControllerControlPlane(
  controller: Pick<FarmingController, "handleMessage">,
  options: Pick<
    ServeOptions,
    "binding" | "describeCredentials" | "logger" | "onListening" | "auth"
  > & {
    settingsWritable?: boolean;
  },
): Promise<FarmingHost & Omit<ControlPlane, "close">> {
  const describeSession = async () =>
    buildSessionView({
      version: CLI_VERSION,
      snapshot: (await controller.handleMessage({
        type: "getSnapshot",
      })) as RuntimeSnapshot<EngineSettings>,
      credentials: options.describeCredentials(),
    });
  // A changed credential reaches the next adapter built; a tick right away
  // lets the auth probe, which owns auth health, report it without waiting.
  const flows = options.auth
    ? createAuthFlows({
        ...options.auth,
        logger: options.logger,
        onCredentialsChanged: () => {
          controller
            .handleMessage({ type: "tickNow" })
            .catch((error: unknown) => options.logger.warn(errorMessage(error), "serve"));
        },
      })
    : undefined;
  let plane: Awaited<ReturnType<typeof startControlPlane>>;
  try {
    plane = await startControlPlane({
      ...options.binding,
      settingsWritable: options.settingsWritable ?? false,
      logger: options.logger,
      handleMessage: (message) => controller.handleMessage(message),
      describeSession,
      ...(flows ? { routes: createAuthRoutes(flows, describeSession) } : {}),
    });
  } catch (error) {
    await flows?.close();
    throw error;
  }
  options.onListening?.({ host: plane.host, port: plane.port });
  return {
    host: plane.host,
    port: plane.port,
    // The server first, so no request starts a flow; then the flows, which
    // stops their polling and releases what they hold.
    close: async () => {
      await plane.close();
      await flows?.close();
    },
  };
}

// `lurkloot serve`: the `run` farming loop, plus the control plane started
// beside it and closed first on shutdown.
export function serveLoop(options: ServeOptions): Promise<void> {
  const { binding, describeCredentials, onListening, auth, ...runOptions } = options;
  return runLoop({
    ...runOptions,
    startHost: (controller) =>
      startControllerControlPlane(controller, {
        binding,
        describeCredentials,
        logger: runOptions.logger,
        settingsWritable: Boolean(runOptions.settingsStore?.applyPatch),
        ...(auth ? { auth } : {}),
        ...(onListening ? { onListening } : {}),
      }),
  });
}
