import React from "react";
import type { PopupAdapter, TFunction } from "./types";

export const I18nContext = React.createContext<{ t: TFunction; dir: "ltr" | "rtl"; locale: string }>({
  t: (key) => key,
  dir: "ltr",
  locale: "en",
});

export const PopupRuntimeContext = React.createContext<{ adapter: PopupAdapter; preview: boolean } | null>(null);

export function useT(): TFunction {
  return React.useContext(I18nContext).t;
}

export function usePopupRuntime(): { adapter: PopupAdapter; preview: boolean } {
  const runtime = React.useContext(PopupRuntimeContext);
  if (!runtime) throw new Error("Popup runtime context is missing");
  return runtime;
}
