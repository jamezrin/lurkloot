import React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Check } from "lucide-react";
import { cn } from "./primitives";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  // Extra content after the label, drawn dimmer (a count).
  count?: React.ReactNode;
}

/** A single-choice row of pressed buttons — the queue facets, the Games mode,
 * the Completed tabs — on Base UI's ToggleGroup, which adds arrow-key movement
 * between the options. One option is always pressed: pressing the current one
 * again is ignored rather than leaving the group empty. `itemAttribute` names a
 * data- attribute each option carries with its value. */
export function Segmented<T extends string>({ label, value, options, onChange, itemAttribute }: {
  label: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange(value: T): void;
  itemAttribute?: string;
}): React.ReactElement {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked && picked !== value) onChange(picked);
      }}
      className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-zinc-800 dark:bg-black/30"
    >
      {options.map((option) => (
        <BaseToggle
          key={option.value}
          value={option.value}
          {...(itemAttribute ? { [itemAttribute]: option.value } : {})}
          className="rounded-md px-2.5 py-0.5 text-[10px] font-semibold text-zinc-400 outline-none transition not-data-[pressed]:hover:text-zinc-600 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[pressed]:bg-[var(--ink)] data-[pressed]:text-[var(--ink-contrast)] dark:not-data-[pressed]:hover:text-zinc-200"
        >
          {option.label}
          {option.count !== undefined ? <span className="ms-1 font-mono text-[9.5px] tabular opacity-70">{option.count}</span> : null}
        </BaseToggle>
      ))}
    </ToggleGroup>
  );
}

/** A small square checkbox on Base UI's Checkbox. */
export function Checkbox({ checked, onChange, label, attributes }: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  attributes?: Record<string, string>;
}): React.ReactElement {
  return (
    <BaseCheckbox.Root
      checked={checked}
      onCheckedChange={(value) => onChange(value)}
      aria-label={label}
      nativeButton
      render={<button type="button" />}
      {...attributes}
      className={cn(
        "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border border-zinc-300 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:border-zinc-600",
        "data-[checked]:border-[var(--ink)] data-[checked]:bg-[var(--ink)] data-[checked]:text-[var(--ink-contrast)]",
      )}
    >
      <BaseCheckbox.Indicator className="flex">
        <Check size={10} strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
