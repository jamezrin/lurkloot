import { describe, expect, it } from "vitest";
import {
  generateOpaqueId,
  isForbiddenOpaqueId,
  normalizeInPagePanelDomTokens,
  PANEL_DOCUMENT_PATH,
} from "../src/core/inPagePanelDom";

describe("inPagePanelDom", () => {
  it("points the iframe at the opaque panel document", () => {
    expect(PANEL_DOCUMENT_PATH).toBe("/p.html");
    expect(PANEL_DOCUMENT_PATH.toLowerCase()).not.toContain("inpage");
    expect(PANEL_DOCUMENT_PATH.toLowerCase()).not.toContain("lurkloot");
  });

  it("generates opaque ids of the expected shape", () => {
    const id = generateOpaqueId();
    expect(id).toMatch(/^[a-z0-9]{12,16}$/);
    expect(isForbiddenOpaqueId(id)).toBe(false);
  });

  it("rejects ids that embed product or role substrings", () => {
    expect(isForbiddenOpaqueId("lurklootabc123")).toBe(true);
    expect(isForbiddenOpaqueId("xxpanelxx1234")).toBe(true);
    expect(isForbiddenOpaqueId("mynavbutton99")).toBe(true);
    expect(isForbiddenOpaqueId("ab12cd34ef56")).toBe(false);
  });

  it("reuses valid persisted tokens and regenerates missing or corrupt ones", () => {
    const valid = { buttonId: "ab12cd34ef56", panelId: "gh78ij90kl12" };
    expect(normalizeInPagePanelDomTokens(valid)).toEqual(valid);

    const repaired = normalizeInPagePanelDomTokens({ buttonId: "lurkloot-nav-button", panelId: 1 });
    expect(repaired.buttonId).toMatch(/^[a-z0-9]{12,16}$/);
    expect(repaired.panelId).toMatch(/^[a-z0-9]{12,16}$/);
    expect(repaired.buttonId).not.toBe("lurkloot-nav-button");
    expect(isForbiddenOpaqueId(repaired.buttonId)).toBe(false);
    expect(isForbiddenOpaqueId(repaired.panelId)).toBe(false);
    expect(repaired.buttonId).not.toBe(repaired.panelId);
  });
});
