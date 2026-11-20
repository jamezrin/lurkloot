import { Socket } from "node:net";
import type { Readable } from "node:stream";
import type { DiagnosticRecord } from "@lurkloot/shared/diagnostics";
import { exportCliDiagnostics } from "./diagnostics";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform } from "@lurkloot/shared/models";
import type { LocalCredentialHealth } from "../authStore";
import { createCliSettingsStore } from "../settingsStore";
import { CLI_VERSION } from "../version";
import { errorMessage } from "@lurkloot/shared/errors";
import {
  createActivityMessageHandler,
  type ActivityHistoryRepository,
} from "@lurkloot/shared/activityHistory";
import {
  buildSessionView,
  isActivityHistoryMessage,
  startControlPlane,
  type ControlPlane,
  type ServeBinding,
} from "./controlPlane";
import { defaultAppRoot } from "./appAssets";
import { createAuthFlows, createAuthRoutes, type AuthFlowsOptions } from "./controlPlaneAuth";
import { runLoop, type FarmingController, type FarmingHost, type RunOptions } from "./run";

export interface ServeOptions extends Omit<RunOptions, "once" | "startHost"> {
  binding: ServeBinding;
  // The config file the settings come from. Without an injected settingsStore,
  // serve reads and saves settings through the config-file store on this path,
  // so the control plane's settings messages are applied and kept (#1000).
  configPath?: string;
  // The network-free credential reading `auth status` reports. Presence and
  // source only; never a credential value.
  describeCredentials: () => Record<Platform, LocalCredentialHealth>;
  // Called with the bound address once the control plane listens (port 0 in tests).
  onListening?: (address: { host: string; port: number }) => void;
  // Enables the sign-in routes (controlPlaneAuth.ts) against this auth store.
  auth?: Omit<AuthFlowsOptions, "logger" | "onCredentialsChanged">;
  // The app UI bundle to serve at `/` (appAssets.ts). Defaults to the one the
  // CLI build put beside it; null serves the control plane alone.
  appRoot?: string | null;
  // Launcher options (`--ready-json`, `--exit-with-stdin`), for a parent
  // process such as the desktop app. With readyOutput, one JSON line
  // `{"event":"ready","url":…}` is written to it once the control plane
  // listens. With exitWithInput, the loop shuts down as on SIGTERM once that
  // stream ends, closes or fails; what it carries is read and discarded.
  readyOutput?: NodeJS.WritableStream;
  exitWithInput?: NodeJS.ReadableStream;
}

// The line `--ready-json` prints. One line, so a launcher reading stdout line
// by line can match it; the URL never carries the token.
export function readyLine(url: string): string {
  return `${JSON.stringify({ event: "ready", url })}\n`;
}

// Calls onEnd once the stream ends, closes or fails, and keeps it flowing so
// the end is seen. A stream already over sends none of those events again, so
// onEnd runs at once. The returned release stops reading, so a stream still
// open after the loop stops does not hold the process. An error listener
// stays, so a late pipe error cannot crash the exit.
function watchStreamEnd(stream: NodeJS.ReadableStream, onEnd: () => void): () => void {
  const state = stream as Partial<Pick<Readable, "readableEnded" | "destroyed" | "closed">>;
  // Node exposes a live stdin pipe or terminal as a Socket. File-backed stdin
  // (including the null device) cannot track a launcher, and its async EOF can
  // arrive after the server listens. Treat it as ended before starting the host.
  const noLauncherInput = !(stream instanceof Socket) && stream === process.stdin;
  if (noLauncherInput || state.readableEnded || state.destroyed || state.closed) {
    stream.on("error", () => {});
    onEnd();
    return () => {};
  }
  const discard = () => {};
  stream.on("data", discard);
  stream.once("end", onEnd);
  stream.once("close", onEnd);
  stream.on("error", onEnd);
  stream.resume();
  return () => {
    stream.removeListener("data", discard);
    stream.removeListener("end", onEnd);
    stream.removeListener("close", onEnd);
    stream.pause();
  };
}

// The control plane for one controller: messages go to handleMessage, and the
// session view is built from the snapshot and the local credential reading.
export async function startControllerControlPlane(
  controller: Pick<FarmingController, "handleMessage">,
  options: Pick<
    ServeOptions,
    | "binding"
    | "describeCredentials"
    | "logger"
    | "onListening"
    | "auth"
    | "appRoot"
    | "readyOutput"
  > & {
    settingsWritable?: boolean;
    recentDiagnostics?: () => readonly DiagnosticRecord[];
    diagnosticSecrets?: RunOptions["diagnosticSecrets"];
    // Answers getActivity, getActivitySessions and clearActivity. Without one
    // they are refused as unsupported.
    activityHistory?: ActivityHistoryRepository;
  },
): Promise<FarmingHost & Omit<ControlPlane, "close">> {
  const readSnapshot = async () =>
    (await controller.handleMessage({ type: "getSnapshot" })) as RuntimeSnapshot<EngineSettings>;
  const describeSession = async () =>
    buildSessionView({
      version: CLI_VERSION,
      snapshot: await readSnapshot(),
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
  const appRoot = options.appRoot === undefined ? defaultAppRoot() : options.appRoot;
  const handleActivityMessage = options.activityHistory
    ? createActivityMessageHandler(options.activityHistory)
    : undefined;
  let plane: Awaited<ReturnType<typeof startControlPlane>>;
  try {
    plane = await startControlPlane({
      ...options.binding,
      settingsWritable: options.settingsWritable ?? false,
      activityHistory: handleActivityMessage !== undefined,
      logger: options.logger,
      handleMessage: async (message) => {
        if (message.type === "exportDiagnostics") {
          const snapshot = await readSnapshot();
          return exportCliDiagnostics({
            snapshot,
            events: options.recentDiagnostics?.() ?? [],
            platform: message.platform,
            secrets: options.diagnosticSecrets?.(),
            history: { source: "live buffer" },
          });
        }
        if (!isActivityHistoryMessage(message)) return controller.handleMessage(message);
        // parseControlPlaneMessage refuses these without a history.
        if (!handleActivityMessage) throw new Error("No activity history to answer from");
        return handleActivityMessage(message);
      },
      describeSession,
      ...(flows ? { routes: createAuthRoutes(flows, describeSession) } : {}),
      ...(appRoot ? { appRoot } : {}),
    });
  } catch (error) {
    await flows?.close();
    throw error;
  }
  options.onListening?.({ host: plane.host, port: plane.port });
  const readyOutput = options.readyOutput;
  return {
    host: plane.host,
    port: plane.port,
    localUrl: plane.localUrl,
    ...(readyOutput
      ? {
          // A launcher that stopped reading must not crash serve: a failed
          // write (EPIPE) is logged, and farming goes on.
          ready: () => {
            readyOutput.on("error", (error: unknown) =>
              options.logger.warn(
                `Could not write the ready line: ${errorMessage(error)}`,
                "serve",
              ),
            );
            readyOutput.write(readyLine(plane.localUrl));
          },
        }
      : {}),
    // The server first, so no request starts a flow; then the flows, which
    // stops their polling and releases what they hold.
    close: async () => {
      await plane.close();
      await flows?.close();
    },
  };
}

// `lurkloot serve`: the `run` farming loop, plus the control plane started
// beside it and closed first on shutdown. Unlike `run`, it saves the settings
// the control plane changes to the config file.
export async function serveLoop(options: ServeOptions): Promise<void> {
  const {
    binding,
    configPath,
    describeCredentials,
    onListening,
    auth,
    appRoot,
    readyOutput,
    exitWithInput,
    ...rest
  } = options;
  const settingsStore =
    rest.settingsStore
    ?? (configPath
      ? createCliSettingsStore(configPath, {
          onUnreadable: (error) =>
            rest.logger.warn(
              `${error.message}; keeping the settings last read until it loads again`,
              "config",
            ),
        })
      : undefined);
  const runOptions = { ...rest, ...(settingsStore ? { settingsStore } : {}) };
  const diagnosticSecrets = () => [binding.token, ...(rest.diagnosticSecrets?.() ?? [])];
  const stop = exitWithInput ? new AbortController() : undefined;
  const release = exitWithInput
    ? watchStreamEnd(exitWithInput, () => stop?.abort("Input closed (--exit-with-stdin)"))
    : undefined;
  try {
    await runLoop({
      ...runOptions,
      diagnosticSecrets,
      // A caller's own stop signal still stops the loop alongside the input one.
      ...(stop
        ? {
            stopSignal: rest.stopSignal
              ? AbortSignal.any([rest.stopSignal, stop.signal])
              : stop.signal,
          }
        : {}),
      startHost: (controller, diagnostics, activityHistory) =>
        startControllerControlPlane(controller, {
          binding,
          describeCredentials,
          logger: runOptions.logger,
          settingsWritable: Boolean(runOptions.settingsStore?.applyPatch),
          activityHistory,
          recentDiagnostics: diagnostics.recent,
          diagnosticSecrets,
          ...(auth ? { auth } : {}),
          ...(onListening ? { onListening } : {}),
          ...(appRoot !== undefined ? { appRoot } : {}),
          ...(readyOutput ? { readyOutput } : {}),
        }),
    });
  } finally {
    release?.();
  }
}
