import { createRoot, type Root } from "react-dom/client";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { Popup } from "@lurkloot/popup-ui";
import { createInPagePanelAdapter } from "./inPagePanelAdapter";
import "./inPagePanel.css";

// The in-page panel: the real <Popup>, mounted in a shadow root on twitch.tv
// and kick.com.
//
// Provisional — still to come: the enable setting, a toggle button, drag,
// position persistence, and managed-tab suppression.

export async function mountInPagePanel(ctx: ContentScriptContext): Promise<void> {
  const ui = await createShadowRootUi(ctx, {
    name: "lurkloot-panel",
    position: "overlay",
    anchor: "body",
    // Twitch and Kick both bind global single-key shortcuts on the document.
    // Without this, typing in a panel input triggers them.
    isolateEvents: true,
    onMount: (container): Root => {
      // Position only. <Popup> sizes itself — its root is
      // `h-[600px] w-[400px] flex flex-col overflow-hidden` and owns its
      // internal scrolling — so constraining width, height or overflow here
      // fights it: an outer scrollbar eats into the 400px the popup insists
      // on, which then overflows horizontally and clips its own content.
      container.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        // Rounds off the popup's square corners for a floating surface. Safe
        // against clipping because the popup root is already overflow-hidden,
        // so no menu escapes its bounds to begin with.
        "border-radius:12px",
        "overflow:hidden",
        "box-shadow:0 12px 32px rgba(0,0,0,.35)",
      ].join(";");

      const root = createRoot(container);
      root.render(<Popup adapter={createInPagePanelAdapter()} />);
      return root;
    },
    onRemove: (root) => {
      root?.unmount();
    },
  });

  ui.mount();
}
