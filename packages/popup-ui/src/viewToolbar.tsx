import React from "react";
import { createPortal } from "react-dom";

/** Where a view's own controls go in the header row, beside the view's title.
 *
 * The popup provides the element; a view hands its first row of controls to
 * `ViewToolbar`, which moves them there. Rendered anywhere without the slot —
 * a test, the site's standalone panels — the controls stay where they are. */
export const ViewToolbarSlotContext = React.createContext<HTMLElement | null>(null);

export function ViewToolbar({ children }: { children: React.ReactNode }): React.ReactElement {
  const slot = React.useContext(ViewToolbarSlotContext);
  if (slot) return createPortal(children, slot);
  return <div className="flex flex-wrap items-center gap-1.5">{children}</div>;
}
