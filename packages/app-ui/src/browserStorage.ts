/** A browser storage area, or one kept in memory for this visit when the
 * browser refuses it. A locked-down browser (blocked site data, some private
 * modes) throws on merely reading `sessionStorage` or `localStorage`, before
 * anything could catch it, and the app would never mount. */
export function storageOrMemory(area: () => Storage): Storage {
  try {
    const storage = area();
    // Some browsers hand the object over and throw on first use instead.
    storage.getItem("");
    return storage;
  } catch {
    return memoryStorage();
  }
}

export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}
