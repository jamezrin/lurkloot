import { describe, expect, it, vi } from "vitest";
import type { MessageCatalog } from "@lurkloot/shared/i18n";
import { createTranslator } from "../../popup-ui/src/translator";

// The popup's own catalogs, with two entries whose English text is identical to
// their key. Those are valid translations, not misses (#565).
const en: MessageCatalog = {
  later: { message: "later" },
  live: { message: "live" },
  finishedPill: { message: "Finished" },
  greeting: { message: "Hello $1" },
};

const es: MessageCatalog = {
  later: { message: "más tarde" },
  live: { message: "en directo" },
  finishedPill: { message: "Finalizada" },
};

describe("popup translator", () => {
  it("keeps a catalog translation whose text equals its key", () => {
    const getMessage = vi.fn(() => "más tarde");
    const t = createTranslator({ languageOverride: "en", overrideCatalog: en, fallbackCatalog: en, getMessage });

    expect(t("later")).toBe("later");
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("falls back to the host message only when no catalog defines the key", () => {
    const getMessage = vi.fn(() => "Ajustes");
    const t = createTranslator({ languageOverride: "en", overrideCatalog: en, fallbackCatalog: en, getMessage });

    expect(t("openSettings")).toBe("Ajustes");
    expect(getMessage).toHaveBeenCalledWith("openSettings", undefined);
  });

  it("renders the key itself when nothing can translate it", () => {
    const t = createTranslator({ languageOverride: "en", overrideCatalog: en, fallbackCatalog: en, getMessage: () => "" });

    expect(t("missingEverywhere")).toBe("missingEverywhere");
  });

  it("prefers the selected locale over the English fallback", () => {
    const getMessage = vi.fn(() => "");
    const t = createTranslator({ languageOverride: "es", overrideCatalog: es, fallbackCatalog: en, getMessage });

    expect(t("later")).toBe("más tarde");
    expect(t("greeting", "Alex")).toBe("Hello Alex");
  });

  it("asks the host first while the language follows the browser", () => {
    const getMessage = vi.fn(() => "más tarde");
    const t = createTranslator({ languageOverride: "browser", overrideCatalog: es, fallbackCatalog: en, getMessage });

    expect(t("later")).toBe("más tarde");
    expect(getMessage).toHaveBeenCalledWith("later", undefined);
  });

  it("uses the catalog while the language follows the browser and the host has no message", () => {
    const t = createTranslator({ languageOverride: "browser", overrideCatalog: es, fallbackCatalog: en, getMessage: () => "" });

    expect(t("finishedPill")).toBe("Finalizada");
  });
});
