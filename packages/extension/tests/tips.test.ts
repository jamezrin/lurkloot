import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { I18nContext } from "../../popup-ui/src/context";
import {
  createTipRotator,
  nextTipIndex,
  randomTipIndex,
  TIP_ROTATION_MS,
  TipsBanner,
} from "../../popup-ui/src/tips";

describe("tip rotation", () => {
  it("chooses a bounded random starting tip", () => {
    expect(randomTipIndex(8, () => 0)).toBe(0);
    expect(randomTipIndex(8, () => 0.999)).toBe(7);
    expect(randomTipIndex(0, () => 0.5)).toBe(0);
  });

  it("advances sequentially and wraps without an immediate repeat", () => {
    expect(nextTipIndex(2, 8)).toBe(3);
    expect(nextTipIndex(7, 8)).toBe(0);
    expect(nextTipIndex(0, 1)).toBe(0);
  });

  it("advances every ten seconds only while visible and cleans up", () => {
    let tick: (() => void) | undefined;
    let intervalMs = 0;
    let cleared: unknown;
    let visible = true;
    let advances = 0;

    const stop = createTipRotator({
      onAdvance: () => { advances += 1; },
      isVisible: () => visible,
      setInterval: (callback, milliseconds) => {
        tick = callback;
        intervalMs = milliseconds;
        return 42;
      },
      clearInterval: (handle) => { cleared = handle; },
    });

    expect(intervalMs).toBe(TIP_ROTATION_MS);
    tick?.();
    expect(advances).toBe(1);
    visible = false;
    tick?.();
    expect(advances).toBe(1);
    stop();
    expect(cleared).toBe(42);
  });
});

describe("TipsBanner", () => {
  it("renders external actions with safe link attributes", () => {
    const html = renderToStaticMarkup(createElement(
      I18nContext.Provider,
      { value: { t: (key: string) => key, dir: "ltr", locale: "en" } },
      createElement(TipsBanner, { initialIndex: 5 }),
    ));

    expect(html).toContain("tipCli");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer\"");
  });

  it("is gated by the popup preference and deterministic in previews", () => {
    const popupSource = readFileSync(resolve(import.meta.dirname, "../../popup-ui/src/Popup.tsx"), "utf8");
    expect(popupSource).toContain("settings.showTips ? <TipsBanner initialIndex={preview ? 0 : undefined} /> : null");
  });

  it("has a Hide tips control in General settings", () => {
    const settingsSource = readFileSync(resolve(import.meta.dirname, "../../popup-ui/src/settingsRegistry.tsx"), "utf8");
    expect(settingsSource).toContain('title={t("hideTipsTitle")}');
    expect(settingsSource).toContain('checked={!settings.showTips}');
    expect(settingsSource).toContain('onChange={(hideTips) => void onSettingsChange({ showTips: !hideTips })}');
  });

  it("localizes every tip and the Hide tips setting in every catalog", () => {
    const requiredKeys = [
      "hideTipsTitle",
      "hideTipsDescription",
      "tipCampaignPriority",
      "tipMissingCampaigns",
      "tipCategorySelection",
      "tipWatchQueue",
      "tipTablessMode",
      "tipCli",
      "tipCliAction",
      "tipFeedback",
      "tipFeedbackAction",
      "tipExcludedCampaigns",
    ];
    const locales = ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar"];

    for (const locale of locales) {
      const catalog = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../locales/messages/${locale}.json`), "utf8"));
      for (const key of requiredKeys) expect(catalog[key]?.message, `${locale}.${key}`).toBeTruthy();
      expect(catalog.priorityHint, `${locale}.priorityHint`).toBeUndefined();
    }
  });
});
