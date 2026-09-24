import React from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { usePortalContainer } from "./portal";

type TooltipHandle = ReturnType<typeof Tooltip.createHandle<{ text: string }>>;

// Each popup owns one tooltip. Every hint is a detached trigger on that handle
// carrying its text as the payload, so a queue of a hundred rows mounts one
// tooltip rather than one per icon button — and two popups on one page (the
// site renders several) never drive each other's.
const TooltipHandleContext = React.createContext<TooltipHandle | null>(null);

/** Shows `label` as a tooltip on its single child, which must accept a ref and
 * props (a DOM element does). The label also lands in `data-tooltip`. Outside a
 * TooltipScope (a component rendered on its own) the child falls back to a
 * native `title`. An empty label renders the child untouched. Tooltips are
 * hints only: anything a screen reader needs still belongs in the child's own
 * aria-label. */
export function Tip({ label, children }: { label: string | undefined; children: React.ReactElement }): React.ReactElement {
  const handle = React.useContext(TooltipHandleContext);
  if (!label) return children;
  if (!handle) return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, { title: label, "data-tooltip": label });
  return (
    <Tooltip.Trigger
      handle={handle}
      payload={{ text: label }}
      data-tooltip={label}
      render={children}
    />
  );
}

/** Wraps one popup: provides its tooltip handle and shared timing, and mounts
 * the tooltip itself. Hover opens after a short delay, and moving between hints
 * opens the next at once, the way native tooltips behave. The tooltip is
 * portalled like the popup's menus (into the shadow root in the site demo) and
 * never takes the pointer. */
export function TooltipScope({ children }: { children: React.ReactNode }): React.ReactElement {
  const [handle] = React.useState(() => Tooltip.createHandle<{ text: string }>());
  const [portalRef, container] = usePortalContainer();
  return (
    <TooltipHandleContext.Provider value={handle}>
      <Tooltip.Provider delay={450} closeDelay={0}>
        {children}
        <span ref={portalRef} hidden />
        <Tooltip.Root handle={handle} disableHoverablePopup>
          {({ payload }) => (
            <Tooltip.Portal container={container}>
              <Tooltip.Positioner sideOffset={6} collisionPadding={8} className="pointer-events-none z-50">
                <Tooltip.Popup className="max-w-[16rem] rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium leading-snug text-white transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-zinc-100 dark:text-zinc-900">
                  {payload?.text}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          )}
        </Tooltip.Root>
      </Tooltip.Provider>
    </TooltipHandleContext.Provider>
  );
}
