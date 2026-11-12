import React from "react";
import type { WatchSourceId } from "@lurkloot/shared/models";

/** What the host behind a PopupAdapter supports. Each flag guards a group of
 * settings and actions; a control whose capability is false is left out of
 * the tree, not disabled. Every flag is required, so a host that declares
 * capabilities has to decide on each new one rather than inherit it. */
export interface PopupHostCapabilities {
  /** Farms in browser tabs. Guards the Farming tabs group (tabless, auto-close,
   * mute, keep videos unmuted, ad focus), pause on manual watch, the tabless
   * fallback limit and Kick page-context recovery. */
  tabs: boolean;
  /** Farms Twitch Extension providers (NoPixel, Fortnite). Guards their rail
   * entries and views, their settings section and their rows in the watch
   * order. */
  twitchExtensions: boolean;
  /** Exports session credentials for the headless CLI. Guards the Export
   * credentials action. */
  credentialExport: boolean;
  /** Keeps the extension's own preferences: start on browser launch, the tips
   * banner and its setting, the in-page panel, diagnostic logging, and the
   * rate and star nudges, which record their answer there. */
  extensionPreferences: boolean;
  /** Lets the user pick the interface language. Guards the language setting.
   * Separate from extensionPreferences: a host without the extension's
   * preferences (the CLI app) can still keep the language on its own. */
  language: boolean;
  /** Keeps an activity history the popup can page through. Guards the
   * Activity log's fetches, its sessions, clear and export; a host without it
   * gets a summary of what the snapshot carries instead. */
  activityHistory: boolean;
}

export type PopupHostCapability = keyof PopupHostCapabilities;

/** The extension's own capabilities, and what a host that declares none gets. */
export const DEFAULT_HOST_CAPABILITIES: Readonly<PopupHostCapabilities> = Object.freeze({
  tabs: true,
  twitchExtensions: true,
  credentialExport: true,
  extensionPreferences: true,
  language: true,
  activityHistory: true,
});

export const HostCapabilitiesContext =
  React.createContext<Readonly<PopupHostCapabilities>>(DEFAULT_HOST_CAPABILITIES);

export function useHostCapabilities(): Readonly<PopupHostCapabilities> {
  return React.useContext(HostCapabilitiesContext);
}

const TWITCH_EXTENSION_SOURCES: ReadonlySet<WatchSourceId> = new Set(["nopixel", "fortnite"]);

/** Whether a watch source is shown to this host. Hidden sources keep their
 * place in the saved order; only the display leaves them out. */
export function watchSourceShown(
  source: WatchSourceId,
  capabilities: Readonly<PopupHostCapabilities>,
): boolean {
  return capabilities.twitchExtensions || !TWITCH_EXTENSION_SOURCES.has(source);
}
