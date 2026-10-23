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
  PENDING_ONBOARDING_KEY,
  armOnboardingForInstall,
  armPendingOnboarding,
  dismissPendingOnboarding,
  loadPendingOnboarding,
} from "../src/core/onboarding";

describe("pending onboarding flag", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.values)) delete mocks.values[key];
  });

  it("arms on a fresh install", async () => {
    await armOnboardingForInstall("install");
    expect(await loadPendingOnboarding()).toBe(true);
  });

  it.each(["update", "chrome_update", "shared_module_update"])("does not arm on %s", async (reason) => {
    await armOnboardingForInstall(reason);
    expect(await loadPendingOnboarding()).toBe(false);
  });

  it("removes the key when dismissed", async () => {
    await armPendingOnboarding();
    await dismissPendingOnboarding();
    expect(await loadPendingOnboarding()).toBe(false);
    expect(PENDING_ONBOARDING_KEY in mocks.values).toBe(false);
  });

  it("treats a non-boolean stored value as unarmed", async () => {
    mocks.values[PENDING_ONBOARDING_KEY] = "yes";
    expect(await loadPendingOnboarding()).toBe(false);
  });
});
