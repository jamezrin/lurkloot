import type { RuntimeMessage } from "@lurkloot/shared/messages";
import { isControlPlaneError } from "./api";
import type { Translate } from "./i18n";

/** Whether a failure means serve could not be reached at all, rather than
 * that it refused one request: the app shows that as a connection warning,
 * not per request. A 5xx without serve's typed body (`http_502` from a proxy
 * in front of a stopped serve) counts; serve's own typed 5xx does not. */
export function isConnectionFailure(error: unknown): boolean {
  if (!isControlPlaneError(error)) return false;
  return (
    error.code === "network_error"
    || error.code === "shutting_down"
    || (error.status >= 500 && error.code.startsWith("http_"))
  );
}

/** What to tell the user when a popup message failed, or undefined when the
 * failure is not theirs to read: a missed snapshot poll is retried by the
 * next one, and a lost connection has its own warning. */
export function describeMessageError(
  error: unknown,
  message: RuntimeMessage,
  t: Translate,
): string | undefined {
  if (message.type === "getSnapshot" || isConnectionFailure(error)) return undefined;
  if (!isControlPlaneError(error)) return t("appErrorGeneric", "unknown");
  const paths = error.paths?.length ? error.paths.join(", ") : "";
  switch (error.code) {
    case "settings_unrepresentable":
      return t("appErrorSettingsUnrepresentable", paths);
    case "settings_invalid":
      return t("appErrorSettingsInvalid", paths);
    case "settings_unavailable":
    case "settings_not_saved":
    case "settings_read_only":
      return t("appErrorSettingsNotSaved");
    case "unsupported_message":
      return t("appErrorUnsupported");
    case "unauthorized":
      return t("appErrorUnauthorized");
    default:
      return t("appErrorGeneric", error.code);
  }
}
