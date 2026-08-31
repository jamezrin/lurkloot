import React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { Popup } from "@lurkloot/popup-ui";
import { createInPagePanelAdapter } from "./inPagePanelAdapter";
import "./inPagePanel.css";

// SPIKE — see docs/spikes/in-page-panel-shadow-root.md.
//
// Mounts the real <Popup> inside a shadow root on twitch.tv / kick.com, to
// answer whether the shared popup stylesheet survives the shadow boundary and
// whether Twitch's CSP / trusted-types policy blocks the style injection.
//
// Provisional: no enable setting, no drag, no position persistence, and no
// managed-tab suppression yet. What is NOT provisional is the shape — this is
// the architecture the feature ships on, so the diagnostics below are the
// go/no-go signal rather than a throwaway harness.

// Reports whether the shadow root actually resolved the tokens the shared sheet
// defines at document level. If these read empty, `inPagePanel.css`'s `:host`
// mirror is not doing its job and the panel will render unstyled.
function StyleProbe(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [report, setReport] = React.useState<string>("measuring…");

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const styles = getComputedStyle(el);
    const font = styles.getPropertyValue("--font-sans").trim();
    const accent = styles.getPropertyValue("--accent").trim();
    // A utility class from the shared sheet; proves Tailwind's output applies
    // inside the shadow root, not just the custom properties.
    const probe = document.createElement("div");
    probe.className = "font-display";
    el.append(probe);
    const utilityApplied = getComputedStyle(probe).fontFamily !== styles.fontFamily;
    probe.remove();

    setReport(
      [
        `--font-sans: ${font || "MISSING"}`,
        `--accent: ${accent || "MISSING"}`,
        `utilities: ${utilityApplied ? "applied" : "NOT APPLIED"}`,
      ].join("  |  "),
    );
  }, []);

  return (
    <div
      ref={ref}
      data-platform="twitch"
      style={{ padding: "6px 10px", font: "11px/1.4 ui-monospace, monospace", background: "#111", color: "#0f0" }}
    >
      {report}
    </div>
  );
}

export async function mountInPagePanelSpike(ctx: ContentScriptContext): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: "lurkloot-panel",
    position: "overlay",
    anchor: "body",
    // Twitch and Kick both bind global single-key shortcuts on the document.
    // Without this, typing in a panel input would trigger them.
    isolateEvents: true,
    onMount: (container): Root => {
      container.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "width:400px",
        "max-height:min(600px, 80vh)",
        "overflow:auto",
        "border-radius:12px",
        "box-shadow:0 12px 32px rgba(0,0,0,.35)",
        "background:var(--surface, #fff)",
      ].join(";");

      const root = createRoot(container);
      root.render(
        <>
          <StyleProbe />
          <Popup adapter={createInPagePanelAdapter()} />
        </>,
      );
      return root;
    },
    onRemove: (root) => {
      root?.unmount();
    },
  });

  ui.mount();
}
