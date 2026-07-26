import { act } from "react";

// The popup fills its labels from loadCatalog(), a dynamic import() of a JSON
// catalog. That needs real module resolution rather than a fixed number of
// microtask flushes, so whether labels are translated by assertion time depends
// on which test file warmed the module cache in that worker. Until it resolves,
// every label renders as its raw message key and copy assertions fail
// intermittently.
//
// Mount helpers should await waitForCatalog() instead of flushing a set number
// of microtasks. Install the loader wrapper it depends on with:
//
//   vi.mock("@lurkloot/locales", async (importOriginal) =>
//     (await import("./helpers/popupCatalog")).delayedLocales(importOriginal));
//
// The factory imports this module dynamically because vi.mock is hoisted above
// the file's own imports.

// Set from a test to emulate a cold module cache: the number of macrotasks the
// catalog import takes to resolve. 0 keeps the real (already warm) timing.
export const catalogDelay = { ticks: 0 };

const loads = { started: 0, settled: 0 };

export function resetCatalogTracking(): void {
  catalogDelay.ticks = 0;
  loads.started = 0;
  loads.settled = 0;
}

type LocalesModule = typeof import("@lurkloot/locales");

export async function delayedLocales(
  importOriginal: <T = LocalesModule>() => Promise<T>,
): Promise<LocalesModule> {
  const actual = await importOriginal<LocalesModule>();
  return {
    ...actual,
    loadCatalog: async (locale: Parameters<LocalesModule["loadCatalog"]>[0]) => {
      loads.started += 1;
      try {
        for (let tick = 0; tick < catalogDelay.ticks; tick += 1) await yieldMacrotask();
        return await actual.loadCatalog(locale);
      } finally {
        loads.settled += 1;
      }
    },
  };
}

// Captured at module load, before any test installs fake timers. Files that fake
// timers (popupAuthHealth) would otherwise deadlock here: a faked setTimeout
// never fires on its own, and driving the faked clock from inside the loader
// wrapper while the wait loop drives it too leaves the load pending forever.
// Yielding on the real event loop keeps this independent of the clock under test.
const realSetTimeout = setTimeout;

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

// Resolves once every catalog load the popup started has settled and React has
// flushed the resulting render. Tracking the loader rather than matching on
// rendered copy keeps this independent of which strings a given test asserts —
// and avoids the trap that "Running · Twitch" is a substring of the
// untranslated "automationRunning · Twitch".
export async function waitForCatalog(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loads.started > 0 && loads.settled >= loads.started) {
      // One more flush so the state set by the last resolved load renders.
      await act(async () => {
        await yieldMacrotask();
      });
      return;
    }
    await act(async () => {
      await yieldMacrotask();
    });
  }
  throw new Error(
    `Popup catalog never finished loading (started ${loads.started}, settled ${loads.settled})`,
  );
}
