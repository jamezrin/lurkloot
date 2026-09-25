import React from "react";

/** Where a floating popup (a select's list, a menu) should be portalled.
 *
 * In the extension that is the document body. The site demo mounts the popup
 * inside a shadow root, whose stylesheet a popup in the page's body would not
 * see, so there the popup goes into the shadow root instead. The returned ref
 * goes on any element inside the popup. */
export function usePortalContainer(): [(node: Element | null) => void, HTMLElement | ShadowRoot | null] {
  const [container, setContainer] = React.useState<HTMLElement | ShadowRoot | null>(null);
  const ref = React.useCallback((node: Element | null) => {
    if (!node) return;
    // A shadow root is a document fragment with a host; checked structurally,
    // since not every environment the popup renders in defines ShadowRoot.
    const root = node.getRootNode();
    setContainer(root.nodeType === 11 && "host" in root ? (root as ShadowRoot) : node.ownerDocument.body);
  }, []);
  return [ref, container];
}
