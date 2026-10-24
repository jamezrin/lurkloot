import type { OnboardingAudience } from "@lurkloot/popup-ui";
import { browser } from "wxt/browser";

export const PENDING_ONBOARDING_KEY = "pendingOnboarding";
// Set once the tour has been armed for this profile, so an upgrader is offered
// it at most once and a reset (a new install) is never offered it again.
export const ONBOARDING_OFFERED_KEY = "onboardingOffered";

export async function loadPendingOnboarding(): Promise<OnboardingAudience | null> {
  const stored = await browser.storage.local.get(PENDING_ONBOARDING_KEY);
  const value = stored[PENDING_ONBOARDING_KEY];
  return value === "new" || value === "returning" ? value : null;
}

export async function armPendingOnboarding(audience: OnboardingAudience = "new"): Promise<void> {
  await browser.storage.local.set({
    [PENDING_ONBOARDING_KEY]: audience,
    [ONBOARDING_OFFERED_KEY]: true,
  });
}

// Removes only the pending flag; the offered marker stays so it is never re-offered.
export async function dismissPendingOnboarding(): Promise<void> {
  await browser.storage.local.remove(PENDING_ONBOARDING_KEY);
}

// A fresh install arms the tour for a new user; the first update on a profile
// that was never offered it arms it once for a returning user. Anything else
// (browser or shared-module updates, later updates) does nothing.
export async function armOnboardingForLifecycle(reason: string): Promise<void> {
  if (reason === "install") {
    await armPendingOnboarding("new");
    return;
  }
  if (reason !== "update") return;
  const stored = await browser.storage.local.get(ONBOARDING_OFFERED_KEY);
  if (stored[ONBOARDING_OFFERED_KEY] === true) return;
  await armPendingOnboarding("returning");
}
