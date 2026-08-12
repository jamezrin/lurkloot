import type { DiagnosticEvent } from "@lurkloot/shared/events";
import type { ChannelCandidate, Platform } from "@lurkloot/shared/models";

export const MAX_PENDING_DISCOVERY_SIGNAL_DIAGNOSTICS = 250;

export interface DiscoverySignalTarget {
  platform: Platform;
  channel: ChannelCandidate;
}

export interface DiscoverySignalController {
  readonly platform: Platform;
  readonly targetKey: string | undefined;
  start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void>;
  drainEvents(): DiagnosticEvent[];
  stop(): Promise<void>;
}

export class PendingDiscoverySignalDiagnostics {
  private readonly events: DiagnosticEvent[] = [];

  push(event: DiagnosticEvent): void {
    if (this.events.length >= MAX_PENDING_DISCOVERY_SIGNAL_DIAGNOSTICS) this.events.shift();
    this.events.push(event);
  }

  drain(): DiagnosticEvent[] {
    return this.events.splice(0);
  }
}
