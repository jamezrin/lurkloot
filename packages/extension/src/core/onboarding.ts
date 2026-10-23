import { browser } from "wxt/browser";

export const PENDING_ONBOARDING_KEY = "pendingOnboarding";

export async function loadPendingOnboarding(): Promise<boolean> {
  const stored = await browser.storage.local.get(PENDING_ONBOARDING_KEY);
  return stored[PENDING_ONBOARDING_KEY] === true;
}

export async function armPendingOnboarding(): Promise<void> {
  await browser.storage.local.set({ [PENDING_ONBOARDING_KEY]: true });
}

export async function dismissPendingOnboarding(): Promise<void> {
  await browser.storage.local.remove(PENDING_ONBOARDING_KEY);
}

// Only a fresh install arms the tour; updates never do.
export async function armOnboardingForInstall(reason: string): Promise<void> {
  if (reason === "install") await armPendingOnboarding();
}
