import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
});

vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { get: mocks.get, set: mocks.set, remove: mocks.remove } } },
}));

import {
  ONBOARDING_OFFERED_KEY,
  PENDING_ONBOARDING_KEY,
  armOnboardingForLifecycle,
  dismissPendingOnboarding,
  loadPendingOnboarding,
} from "../src/core/onboarding";

describe("pending onboarding flag", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.values)) delete mocks.values[key];
    mocks.set.mockClear();
  });

  it("arms a new user on a fresh install", async () => {
    await armOnboardingForLifecycle("install");
    expect(await loadPendingOnboarding()).toBe("new");
    expect(mocks.values[ONBOARDING_OFFERED_KEY]).toBe(true);
    expect(mocks.set).toHaveBeenCalledOnce();
  });

  it("arms a returning user on the first update, in one write", async () => {
    await armOnboardingForLifecycle("update");
    expect(await loadPendingOnboarding()).toBe("returning");
    expect(mocks.values[ONBOARDING_OFFERED_KEY]).toBe(true);
    expect(mocks.set).toHaveBeenCalledOnce();
  });

  it("does not offer again on a second update after dismissal", async () => {
    await armOnboardingForLifecycle("update");
    await dismissPendingOnboarding();
    await armOnboardingForLifecycle("update");
    expect(await loadPendingOnboarding()).toBeNull();
  });

  it("does nothing on update when already offered", async () => {
    mocks.values[ONBOARDING_OFFERED_KEY] = true;
    await armOnboardingForLifecycle("update");
    expect(await loadPendingOnboarding()).toBeNull();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["chrome_update", "shared_module_update"])("does nothing on %s", async (reason) => {
    await armOnboardingForLifecycle(reason);
    expect(await loadPendingOnboarding()).toBeNull();
    expect(ONBOARDING_OFFERED_KEY in mocks.values).toBe(false);
  });

  it("keeps the offered marker when dismissed", async () => {
    await armOnboardingForLifecycle("install");
    await dismissPendingOnboarding();
    expect(await loadPendingOnboarding()).toBeNull();
    expect(PENDING_ONBOARDING_KEY in mocks.values).toBe(false);
    expect(mocks.values[ONBOARDING_OFFERED_KEY]).toBe(true);
  });

  it("treats a non-audience stored value as unarmed", async () => {
    mocks.values[PENDING_ONBOARDING_KEY] = "yes";
    expect(await loadPendingOnboarding()).toBeNull();
    mocks.values[PENDING_ONBOARDING_KEY] = true;
    expect(await loadPendingOnboarding()).toBeNull();
  });
});
