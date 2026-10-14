import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectKickDocument } from "../src/core/kickPageDocument";

// The inspector runs in the page's MAIN world, so it is driven here against a
// stubbed `document` rather than through a browser.
function kickDocument(contentType: string, text: string, tagName = "HTML") {
  vi.stubGlobal("document", {
    contentType,
    body: { textContent: text },
    documentElement: { tagName },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inspectKickDocument", () => {
  it("reports Kick's security-policy JSON with its reason and reference (#794)", () => {
    kickDocument("application/json", JSON.stringify({ error: "Request blocked by security policy.", reference: "c0e117f5" }));

    expect(inspectKickDocument()).toEqual({
      usable: false,
      failure: { kind: "security_policy_blocked", reason: "Request blocked by security policy.", reference: "c0e117f5" },
    });
  });

  it("accepts the HTML channel page", () => {
    kickDocument("text/html", "floridaboy is live");

    expect(inspectKickDocument()).toEqual({ usable: true });
  });

  it("rejects other JSON as an invalid response rather than a block", () => {
    kickDocument("application/json", JSON.stringify({ message: "Not found" }));

    expect(inspectKickDocument()).toEqual({ usable: false, failure: { kind: "invalid_response", reason: "Not found" } });
  });

  it("rejects a non-HTML document", () => {
    kickDocument("text/plain", "maintenance", "PLAINTEXT");

    expect(inspectKickDocument()).toEqual({
      usable: false,
      failure: { kind: "invalid_response", reason: "Kick served a non-HTML document" },
    });
  });

  it("stays self-contained, because executeScript serializes only its source", () => {
    const isolated = new Function(`return (${inspectKickDocument.toString()})`)() as typeof inspectKickDocument;
    kickDocument("application/json", JSON.stringify({ error: "Request blocked by security policy." }));

    expect(isolated()).toMatchObject({ usable: false, failure: { kind: "security_policy_blocked" } });
  });
});
