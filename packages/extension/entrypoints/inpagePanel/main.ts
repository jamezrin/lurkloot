import { browser } from "wxt/browser";

// SPIKE ONLY — see docs/spikes/in-page-panel-frame-embedding.md.
//
// This page exists to answer one question: does an extension page load in an
// iframe injected into twitch.tv / kick.com, or does the host page's CSP block
// it? Everything here is throwaway; the real panel renders <Popup> instead.
//
// It also confirms the second half of the design premise — that the panel runs
// in a genuine extension page context, so `browser.*` is available and the
// popup's document-level stylesheet (`:root` / `html` / `body`) would apply.

const root = document.getElementById("root")!;

function line(label: string, value: string, ok: boolean): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:baseline;font:12px/1.6 ui-monospace,monospace";
  const mark = document.createElement("span");
  mark.textContent = ok ? "PASS" : "FAIL";
  mark.style.cssText = `font-weight:700;color:${ok ? "#15803d" : "#b91c1c"}`;
  const text = document.createElement("span");
  text.textContent = `${label}: ${value}`;
  row.append(mark, text);
  return row;
}

// Reaching this line at all is the primary result: the frame was not blocked.
root.textContent = "";
root.style.cssText = "padding:12px;font:13px/1.5 system-ui,sans-serif;color:#111";

const heading = document.createElement("strong");
heading.textContent = "Frame embedding: the iframe rendered.";
heading.style.cssText = "display:block;margin-bottom:8px;font-size:14px";
root.append(heading);

root.append(line("origin", location.origin, location.protocol.endsWith("extension:")));

// `browser.runtime.getManifest()` only resolves in a real extension context, so
// this distinguishes "the frame loaded" from "the frame loaded with privileges".
let version = "unavailable";
let privileged = false;
try {
  version = browser.runtime.getManifest().version;
  privileged = true;
} catch (error) {
  version = error instanceof Error ? error.message : String(error);
}
root.append(line("browser.runtime", privileged ? `manifest v${version}` : version, privileged));

// The document-level selectors the real panel depends on. In a shadow root
// these match nothing; here they should resolve normally.
const documentScoped = Boolean(document.documentElement && document.body);
root.append(line("html/body present", String(documentScoped), documentScoped));

void browser.runtime
  .sendMessage({ type: "getSnapshot" })
  .then((snapshot: unknown) => {
    root.append(line("getSnapshot round-trip", snapshot ? "responded" : "empty", Boolean(snapshot)));
  })
  .catch((error: unknown) => {
    root.append(line("getSnapshot round-trip", error instanceof Error ? error.message : String(error), false));
  });
