import type { LegacyEventLogEntry } from "@lurkloot/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    clearActivityEvents: vi.fn(),
    importLegacyActivityEvents: vi.fn(),
  };
});

vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { get: mocks.get, set: mocks.set } } },
}));

vi.mock("../src/core/activityStorage", () => ({
  appendActivityEvents: vi.fn(),
  clearActivityEvents: mocks.clearActivityEvents,
  importLegacyActivityEvents: mocks.importLegacyActivityEvents,
}));

import { DEFAULT_STATE, loadState, resetStorage, saveState } from "../src/core/storage";

const legacyEvents: LegacyEventLogEntry[] = [{
  id: "legacy-1",
  at: "2026-07-01T12:00:00.000Z",
  platform: "twitch",
  level: "info",
  message: "legacy event",
}];

describe("legacy activity migration", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.values)) delete mocks.values[key];
    mocks.get.mockClear();
    mocks.set.mockClear();
    mocks.clearActivityEvents.mockReset();
    mocks.importLegacyActivityEvents.mockReset();
    mocks.values.schedulerState = { ...DEFAULT_STATE, events: legacyEvents };
  });

  it("preserves raw legacy events across load and save when import fails", async () => {
    mocks.importLegacyActivityEvents.mockRejectedValueOnce(new Error("IDB unavailable"));

    const state = await loadState();
    await saveState(state);

    expect(mocks.values.schedulerState).toEqual(expect.objectContaining({ events: legacyEvents }));
  });

  it("retries migration and removes raw events only after the import commits", async () => {
    mocks.importLegacyActivityEvents
      .mockRejectedValueOnce(new Error("IDB unavailable"))
      .mockResolvedValueOnce(undefined);

    await loadState();
    await saveState(DEFAULT_STATE);
    expect(mocks.values.schedulerState).toEqual(expect.objectContaining({ events: legacyEvents }));

    await loadState();

    expect(mocks.importLegacyActivityEvents).toHaveBeenLastCalledWith([expect.objectContaining({
      id: "legacy-1",
      at: legacyEvents[0]?.at,
      category: "diagnostic",
      legacy: true,
    })]);
    expect(mocks.values.schedulerState).not.toHaveProperty("events");
  });

  it("serializes a concurrent save behind legacy import so newer scheduler state survives", async () => {
    let finishImport!: () => void;
    const importPending = new Promise<void>((resolve) => {
      finishImport = resolve;
    });
    mocks.importLegacyActivityEvents.mockReturnValueOnce(importPending);
    const newerState = { ...DEFAULT_STATE, lastTickAt: "2026-07-14T12:34:56.000Z" };

    const loading = loadState();
    await vi.waitFor(() => expect(mocks.importLegacyActivityEvents).toHaveBeenCalledOnce());
    const saving = saveState(newerState);
    finishImport();
    await Promise.all([loading, saving]);

    expect(mocks.values.schedulerState).toEqual(newerState);
    expect(mocks.values.schedulerState).not.toHaveProperty("events");
  });

  it("serializes reset behind an in-flight state migration", async () => {
    let finishImport!: () => void;
    const importPending = new Promise<void>((resolve) => {
      finishImport = resolve;
    });
    mocks.importLegacyActivityEvents.mockReturnValueOnce(importPending);

    const loading = loadState();
    await vi.waitFor(() => expect(mocks.importLegacyActivityEvents).toHaveBeenCalledOnce());
    const resetting = resetStorage();
    await Promise.resolve();

    expect(mocks.set).not.toHaveBeenCalled();

    finishImport();
    await Promise.all([loading, resetting]);

    expect(mocks.values.schedulerState).toEqual(DEFAULT_STATE);
    expect(mocks.clearActivityEvents).toHaveBeenCalledOnce();
  });

  it("keeps a successful operational reset when activity storage is unavailable", async () => {
    mocks.clearActivityEvents.mockRejectedValueOnce(new Error("IDB unavailable"));

    await expect(resetStorage()).resolves.toBeUndefined();

    expect(mocks.values.schedulerState).toEqual(DEFAULT_STATE);
  });
});
