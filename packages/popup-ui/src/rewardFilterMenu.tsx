import type React from "react";
import { useId, useRef, useState } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check, ChevronDown } from "lucide-react";
import type {
  Platform,
  RewardFilter,
  RewardKind,
  SubscriptionRewardMode,
  UnlinkedCampaignMode,
} from "@lurkloot/shared/models";
import {
  PLATFORM_REWARD_KINDS,
  REWARD_KINDS,
  SUBSCRIPTION_REWARD_MODES,
  defaultRewardFilter,
  isRewardFilterNarrowed,
  normalizeRewardFilter,
} from "@lurkloot/shared/rewardFilter";
import {
  DEFAULT_UNLINKED_CAMPAIGN_MODE,
  UNLINKED_CAMPAIGN_MODES,
} from "@lurkloot/shared/unlinkedCampaigns";
import { useT } from "./context";
import { FLOATING_POPUP_CLASS } from "./dropdown";
import { usePortalContainer } from "./portal";
import { useCloseOnOutsideScroll } from "./outsideScroll";
import { cn } from "./primitives";
import type { TFunction } from "./types";

const KIND_KEYS: Record<RewardKind, string> = {
  item: "rewardKindItem",
  badge: "rewardKindBadge",
  emote: "rewardKindEmote",
};

// The trigger has little room, so it names items by the short form.
const KIND_SHORT_KEYS: Record<RewardKind, string> = {
  item: "rewardKindItemShort",
  badge: "rewardKindBadge",
  emote: "rewardKindEmote",
};

const MODE_KEYS: Record<SubscriptionRewardMode, string> = {
  include: "subscriptionModeInclude",
  skip: "subscriptionModeSkip",
  only: "subscriptionModeOnly",
};

const MODE_HINT_KEYS: Record<SubscriptionRewardMode, string> = {
  include: "subscriptionModeIncludeHint",
  skip: "subscriptionModeSkipHint",
  only: "subscriptionModeOnlyHint",
};

const MODE_LABEL_KEYS: Partial<Record<SubscriptionRewardMode, string>> = {
  skip: "rewardFilterNoSub",
  only: "rewardFilterSubOnly",
};

const UNLINKED_MODE_KEYS: Record<UnlinkedCampaignMode, string> = {
  include: "unlinkedModeInclude",
  skip: "unlinkedModeSkip",
  last: "unlinkedModeLast",
};

const UNLINKED_MODE_HINT_KEYS: Record<UnlinkedCampaignMode, string> = {
  include: "unlinkedModeIncludeHint",
  skip: "unlinkedModeSkipHint",
  last: "unlinkedModeLastHint",
};

const UNLINKED_MODE_LABEL_KEYS: Partial<Record<UnlinkedCampaignMode, string>> = {
  skip: "rewardFilterNoUnlinked",
  last: "rewardFilterUnlinkedLast",
};

const SECTION_TITLE_CLASS =
  "text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const HINT_CLASS = "text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400";
// A checkbox row is the checkbox itself, text included, so the whole row is
// one click target and its name comes from its text. (An enclosing <label>
// would also forward the click to Base UI's hidden input.)
const CHECK_ROW_CLASS =
  "group flex w-full cursor-default select-none items-center gap-2 rounded-md px-1 py-1 text-start text-[11.5px] text-zinc-700 outline-none hover:bg-[var(--ink-soft)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent dark:text-zinc-200";
const BOX_CLASS =
  "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border border-zinc-300 group-data-[checked]:border-[var(--ink)] group-data-[checked]:bg-[var(--ink)] group-data-[checked]:text-[var(--ink-contrast)] group-data-[disabled]:opacity-60 dark:border-zinc-600";

function CheckRow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <span className={BOX_CLASS}>
        <Checkbox.Indicator className="flex">
          <Check size={10} strokeWidth={3} aria-hidden />
        </Checkbox.Indicator>
      </span>
      {children}
    </>
  );
}

/** A row of mutually exclusive options, one of them always chosen. Every
 * three-way choice in the reward menu and in Settings uses it, so they look
 * and behave the same. `attribute` names the data attributes tests read:
 * data-<attribute>-mode on the group, data-<attribute>-option on each option. */
function SegmentedChoice<T extends string>({
  labelledBy,
  describedBy,
  options,
  value,
  optionLabel,
  attribute,
  onChange,
}: {
  labelledBy: string;
  describedBy: string;
  options: readonly T[];
  value: T;
  optionLabel(option: T): string;
  attribute: string;
  onChange(value: T): void;
}): React.ReactElement {
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      value={value}
      onValueChange={(next) => {
        const option = options.find((entry) => entry === next);
        if (option && option !== value) onChange(option);
      }}
      {...{ [`data-${attribute}-mode`]: value }}
      className="flex gap-0.5 rounded-lg border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-zinc-800 dark:bg-black/30"
    >
      {options.map((option) => (
        <Radio.Root
          key={option}
          value={option}
          {...{ [`data-${attribute}-option`]: option }}
          className="flex-1 cursor-default select-none rounded-md py-1 text-center text-[11px] font-semibold text-zinc-500 outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] not-data-[checked]:hover:text-zinc-800 data-[checked]:bg-[var(--ink)] data-[checked]:text-[var(--ink-contrast)] dark:text-zinc-400 dark:not-data-[checked]:hover:text-zinc-100"
        >
          {optionLabel(option)}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** What happens to campaigns whose account is not linked: farmed, skipped, or
 * farmed after every linked one. Shared by the Queue menu and Settings, like
 * RewardFilterFields, so both edit the one setting the same way. */
export function UnlinkedCampaignsField({
  value,
  onChange,
}: {
  value: UnlinkedCampaignMode;
  onChange(value: UnlinkedCampaignMode): void;
}): React.ReactElement {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  return (
    <div className="space-y-1">
      <div id={titleId} className={SECTION_TITLE_CLASS}>
        {t("unlinkedCampaignsTitle")}
      </div>
      <SegmentedChoice
        labelledBy={titleId}
        describedBy={hintId}
        options={UNLINKED_CAMPAIGN_MODES}
        value={value}
        optionLabel={(mode) => t(UNLINKED_MODE_KEYS[mode])}
        attribute="unlinked"
        onChange={onChange}
      />
      <p id={hintId} className={HINT_CLASS}>
        {t(UNLINKED_MODE_HINT_KEYS[value])}
      </p>
    </div>
  );
}

/** The filter in a few words: only what is narrowed, kinds first and then the
 * subscription mode ("Badges, Emotes · no sub"), or "All rewards". */
export function rewardFilterLabel(filter: RewardFilter, platform: Platform, t: TFunction): string {
  const current = normalizeRewardFilter(filter, platform);
  if (!isRewardFilterNarrowed(current, platform)) return t("rewardFilterAll");
  const kinds =
    current.kinds.length === PLATFORM_REWARD_KINDS[platform].length
      ? t("rewardFilterAllKinds")
      : current.kinds.map((kind) => t(KIND_SHORT_KEYS[kind])).join(", ");
  const mode = MODE_LABEL_KEYS[current.subscriptions];
  return mode ? `${kinds} · ${t(mode)}` : kinds;
}

/** Whether RewardFilterFields asks anything at all. On a platform with one
 * kind and no subscription rewards it has nothing to render. */
export function hasRewardFilterFields(platform: Platform, showSubscriptions: boolean): boolean {
  return PLATFORM_REWARD_KINDS[platform].length > 1 || showSubscriptions;
}

/** The two questions of the reward filter: which kinds, and what to do with
 * rewards that need a subscription. Shared by the Queue menu and Settings, so
 * both edit the one setting the same way. */
export function RewardFilterFields({
  platform,
  filter,
  showSubscriptions,
  counts,
  onChange,
}: {
  platform: Platform;
  filter: RewardFilter;
  // Whether to ask the subscription question (showsSubscriptionChoice).
  showSubscriptions: boolean;
  // How many campaigns each kind alone would queue (rewardKindCounts).
  counts?: Partial<Record<RewardKind, number>>;
  onChange(filter: RewardFilter): void;
}): React.ReactElement {
  const t = useT();
  const kindsId = useId();
  const kindsHintId = useId();
  const modesId = useId();
  const modesHintId = useId();
  const current = normalizeRewardFilter(filter, platform);
  const available = PLATFORM_REWARD_KINDS[platform];
  return (
    <div className="space-y-3">
      {available.length > 1 ? (
        <div className="space-y-1">
          <div id={kindsId} className={SECTION_TITLE_CLASS}>
            {t("rewardKindsTitle")}
          </div>
          <p id={kindsHintId} className={HINT_CLASS}>
            {t("rewardKindsDescription")}
          </p>
          <CheckboxGroup
            aria-labelledby={kindsId}
            aria-describedby={kindsHintId}
            value={current.kinds}
            onValueChange={(next) => {
              // Kept in the platform's order; never empty, so the filter
              // always farms something.
              const kinds = REWARD_KINDS.filter(
                (kind) => available.includes(kind) && next.includes(kind),
              );
              if (kinds.length > 0) onChange({ ...current, kinds });
            }}
            className="flex flex-col"
          >
            {available.map((kind) => {
              const last = current.kinds.length === 1 && current.kinds[0] === kind;
              return (
                <Checkbox.Root
                  key={kind}
                  value={kind}
                  disabled={last}
                  data-reward-kind={kind}
                  className={CHECK_ROW_CLASS}
                >
                  <CheckRow>
                    <span className="min-w-0 flex-1 truncate">{t(KIND_KEYS[kind])}</span>
                    {counts?.[kind] !== undefined ? (
                      <span
                        aria-hidden
                        className="font-mono text-[10px] tabular text-zinc-400 dark:text-zinc-500"
                      >
                        {counts[kind]}
                      </span>
                    ) : null}
                  </CheckRow>
                </Checkbox.Root>
              );
            })}
          </CheckboxGroup>
        </div>
      ) : null}
      {showSubscriptions ? (
        <div className="space-y-1">
          <div id={modesId} className={SECTION_TITLE_CLASS}>
            {t("subscriptionRewardsTitle")}
          </div>
          <SegmentedChoice
            labelledBy={modesId}
            describedBy={modesHintId}
            options={SUBSCRIPTION_REWARD_MODES}
            value={current.subscriptions}
            optionLabel={(mode) => t(MODE_KEYS[mode])}
            attribute="subscription"
            onChange={(mode) => onChange({ ...current, subscriptions: mode })}
          />
          <p id={modesHintId} className={HINT_CLASS}>
            {t(MODE_HINT_KEYS[current.subscriptions])}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The Queue's "Rewards to farm" button and menu. The button names what the
 * filter narrows; the menu edits the same per-platform setting as Settings.
 *
 * It is non-modal, like Dropdown: a modal popover locks page scroll by
 * restyling the body, and every body restyle makes Chrome re-measure the
 * extension popup. So any scroll outside the menu closes it
 * (useCloseOnOutsideScroll). */
export function RewardFilterMenu({
  platform,
  filter,
  showSubscriptions,
  counts,
  farmPinnedOnly,
  unlinkedCampaigns,
  onChange,
  onFarmPinnedOnlyChange,
  onUnlinkedCampaignsChange,
}: {
  platform: Platform;
  filter: RewardFilter;
  showSubscriptions: boolean;
  counts?: Partial<Record<RewardKind, number>>;
  farmPinnedOnly: boolean;
  unlinkedCampaigns: UnlinkedCampaignMode;
  onChange(filter: RewardFilter): void;
  onFarmPinnedOnlyChange(value: boolean): void;
  onUnlinkedCampaignsChange(value: UnlinkedCampaignMode): void;
}): React.ReactElement {
  const t = useT();
  const [portalRef, container] = usePortalContainer();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideScroll(open, () => setOpen(false), popupRef, container);
  const fields = hasRewardFilterFields(platform, showSubscriptions);
  // Pinned-only and the unlinked mode change what is farmed as much as the
  // filter does, and the closed button is the only place the Queue says so.
  const unlinkedChanged = unlinkedCampaigns !== DEFAULT_UNLINKED_CAMPAIGN_MODE;
  const narrowed = farmPinnedOnly || unlinkedChanged || isRewardFilterNarrowed(filter, platform);
  const unlinkedLabelKey = UNLINKED_MODE_LABEL_KEYS[unlinkedCampaigns];
  const label = [
    rewardFilterLabel(filter, platform, t),
    ...(unlinkedLabelKey ? [t(unlinkedLabelKey)] : []),
    ...(farmPinnedOnly ? [t("rewardFilterPinnedOnly")] : []),
  ].join(" · ");
  return (
    <Popover.Root modal={false} open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={portalRef}
        data-reward-filter=""
        data-tour="reward-filter"
        // The visible label names only the narrowing; the name says what it is.
        aria-label={`${t("rewardFilterTitle")}: ${label}`}
        {...(narrowed ? { "data-narrowed": "" } : {})}
        title={t("rewardFilterTitle")}
        className="flex max-w-[11rem] shrink-0 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-700 outline-none transition-colors hover:border-zinc-400 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[narrowed]:border-[var(--accent-ring)] data-[narrowed]:bg-[var(--accent-soft)] data-[narrowed]:text-[var(--accent-text)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className="shrink-0 text-zinc-400 transition-transform in-data-[popup-open]:rotate-180 dark:text-zinc-500"
        />
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 outline-none"
        >
          <Popover.Popup
            ref={popupRef}
            aria-label={t("rewardFilterTitle")}
            className={cn(
              FLOATING_POPUP_CLASS,
              "nice-scroll max-h-[var(--available-height)] w-[15.5rem] space-y-2 overflow-y-auto overscroll-contain p-2.5 shadow-lg",
            )}
          >
            {fields ? (
              <RewardFilterFields
                platform={platform}
                filter={filter}
                showSubscriptions={showSubscriptions}
                counts={counts}
                onChange={onChange}
              />
            ) : null}
            <div className={cn(fields && "border-t border-zinc-200 pt-2 dark:border-zinc-800")}>
              <UnlinkedCampaignsField
                value={unlinkedCampaigns}
                onChange={onUnlinkedCampaignsChange}
              />
            </div>
            <div className="border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
              <Checkbox.Root
                checked={farmPinnedOnly}
                onCheckedChange={(value) => onFarmPinnedOnlyChange(value)}
                data-queue-pinned-only=""
                className={CHECK_ROW_CLASS}
              >
                <CheckRow>
                  <span className="min-w-0 flex-1">{t("farmPinnedOnlyTitle")}</span>
                </CheckRow>
              </Checkbox.Root>
            </div>
            {narrowed ? (
              <div className="border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
                <button
                  type="button"
                  data-reward-filter-reset=""
                  // Reset clears everything the button names: the unlinked mode
                  // and pinned-only too.
                  onClick={() => {
                    onChange(defaultRewardFilter(platform));
                    if (unlinkedChanged) onUnlinkedCampaignsChange(DEFAULT_UNLINKED_CAMPAIGN_MODE);
                    if (farmPinnedOnly) onFarmPinnedOnlyChange(false);
                  }}
                  className="w-full rounded-md px-1 py-1 text-start text-[11.5px] font-semibold text-zinc-800 underline decoration-zinc-300 underline-offset-2 outline-none hover:bg-[var(--ink-soft)] hover:decoration-current focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-100 dark:decoration-zinc-600"
                >
                  {t("rewardFilterReset")}
                </button>
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
