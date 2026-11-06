import React from "react";
import type { Platform } from "@lurkloot/shared/models";
import type { PopupAdapter, TFunction } from "./types";

export const I18nContext = React.createContext<{
  t: TFunction;
  dir: "ltr" | "rtl";
  locale: string;
}>({
  t: (key) => key,
  dir: "ltr",
  locale: "en",
});

export const PopupRuntimeContext = React.createContext<{
  adapter: PopupAdapter;
  preview: boolean;
} | null>(null);

// Marks or unmarks a subscription reward as subscribed. Provided once by the
// popup and read by each campaign card; without it no mark control is shown.
export const SubscriptionMarkContext = React.createContext<
  ((campaignId: string, rewardId: string) => void) | null
>(null);

// Equips one lane of a reward campaign's track (#904). Provided once by the
// popup; without it no lane picker is shown.
export const RewardLaneContext = React.createContext<
  ((campaignId: string, track: string, lane: string) => void) | null
>(null);

// Where the status line's Sign in action goes on a host that signs in itself
// (the CLI app's Accounts view). Without it the action opens the platform's
// own sign-in page, which is how the extension's browser session signs in.
export const SignInActionContext = React.createContext<((platform: Platform) => void) | null>(null);

export function useT(): TFunction {
  return React.useContext(I18nContext).t;
}

export function usePopupRuntime(): { adapter: PopupAdapter; preview: boolean } {
  const runtime = React.useContext(PopupRuntimeContext);
  if (!runtime) throw new Error("Popup runtime context is missing");
  return runtime;
}
