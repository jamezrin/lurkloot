import React from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { usePortalContainer } from "./portal";
import { cn } from "./primitives";
import { Tip } from "./tooltip";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/** Classes shared by every floating popup: one flat surface and a hairline. */
export const FLOATING_POPUP_CLASS =
  "rounded-lg border border-zinc-200 bg-white p-1 text-zinc-800 outline-none transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100";

/** A select drawn by the popup instead of the platform, built on Base UI's
 * Select. A native <select> opens an OS menu the page cannot style: on Linux it
 * came up white in a dark popup, with the selected option white on white.
 *
 * It is non-modal: a modal select locks page scroll by restyling the body,
 * and every body restyle makes Chrome re-measure the extension popup. */
export function Dropdown<T extends string>({ label, value, options, onChange, disabled = false, title, prefix, className, attributes }: {
  // The accessible name, also used for the list.
  label: string;
  value: T;
  options: Array<DropdownOption<T>>;
  onChange(value: T): void | Promise<void>;
  disabled?: boolean;
  // A tooltip for the trigger, e.g. why it is disabled.
  title?: string;
  // Rendered inside the trigger before the value, e.g. "Then by".
  prefix?: React.ReactNode;
  // Classes for the trigger, which carries the control's box.
  className?: string;
  // Extra attributes for the trigger, such as a data- hook.
  attributes?: Record<string, string>;
}): React.ReactElement {
  const [portalRef, container] = usePortalContainer();
  return (
    <Select.Root
      items={options}
      value={value}
      disabled={disabled}
      modal={false}
      onValueChange={(next) => {
        if (next !== null && next !== value) void onChange(next as T);
      }}
    >
      <Tip label={title}>
        <Select.Trigger
          ref={portalRef}
          aria-label={label}
          data-value={value}
          {...attributes}
          className={cn("flex w-full min-w-0 items-center gap-1 text-start outline-none data-[disabled]:cursor-not-allowed", className)}
        >
          {prefix}
          <Select.Value className="min-w-0 flex-1 truncate" />
          <Select.Icon className="flex shrink-0 text-zinc-400 transition-transform data-[popup-open]:rotate-180 dark:text-zinc-500">
            <ChevronDown size={12} aria-hidden />
          </Select.Icon>
        </Select.Trigger>
      </Tip>
      <Select.Portal container={container}>
        <Select.Positioner alignItemWithTrigger={false} align="end" sideOffset={4} collisionPadding={8} className="z-50 outline-none">
          <Select.Popup aria-label={label} className={cn(FLOATING_POPUP_CLASS, "max-h-[var(--available-height)] min-w-[var(--anchor-width)] max-w-[18rem]")}>
            <Select.List className="nice-scroll max-h-[240px] overflow-y-auto">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  className="flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-[11.5px] text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[selected]:font-semibold data-[highlighted]:text-zinc-950 data-[selected]:text-zinc-950 dark:text-zinc-200 dark:data-[highlighted]:bg-zinc-800 dark:data-[highlighted]:text-white dark:data-[selected]:text-white"
                >
                  <Select.ItemText className="min-w-0 flex-1 truncate">{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="flex w-3 shrink-0" keepMounted={false}>
                    <Check size={12} aria-hidden />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
