import { describe, expect, it } from "vitest";
import { storageOrMemory } from "../src/browserStorage";

describe("storageOrMemory", () => {
  it("keeps the browser's storage when it can be read", () => {
    expect(storageOrMemory(() => sessionStorage)).toBe(sessionStorage);
  });

  it("falls back to memory when the getter itself throws", () => {
    const storage = storageOrMemory(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(storage.getItem("a")).toBeNull();
    storage.setItem("a", "1");
    expect(storage.getItem("a")).toBe("1");
    expect(storage.length).toBe(1);
    storage.removeItem("a");
    expect(storage.getItem("a")).toBeNull();
  });

  it("falls back to memory when the storage throws on first use", () => {
    const refusing = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;
    const storage = storageOrMemory(() => refusing);
    expect(storage).not.toBe(refusing);
    storage.setItem("b", "2");
    expect(storage.getItem("b")).toBe("2");
  });
});
