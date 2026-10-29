import type React from "react";
import { useId, useRef, useState } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check, ChevronDown, ListOrdered, Pin, Star } from "lucide-react";
import type {
  Platform,
  RewardFilter,
  RewardKind,
  SubscriptionRewardMode,
  UnlinkedCampaignMode,
} from "@lurkloot/shared/models";
import {
  PLATFORM_REWARD_KINDS,
  REWARD_GROUPS,
  REWARD_KINDS,
  SUBSCRIPTION_REWARD_MODES,
  defaultRewardFilter,
  isRewardFilterNarrowed,
  normalizeRewardFilter,
  rewardGroupKinds,
  rewardGroupsDiffer,
  withRewardGroupKinds,
  type RewardGroup,
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

const GROUP_KEYS: Record<RewardGroup, string> = {
  pinned: "rewardGroupPinned",
  favourite: "rewardGroupFavourite",
  other: "rewardGroupOther",
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
const BOX_CLASS =
  "grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border border-zinc-300 group-data-[checked]:border-[var(--ink)] group-data-[checked]:bg-[var(--ink)] group-data-[checked]:text-[var(--ink-contrast)] group-data-[disabled]:opacity-60 dark:border-zinc-600";

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

/** Whether only pinned campaigns are farmed: the favourite and other groups
 * farm no kinds (#932). */
export function farmsPinnedOnly(filter: RewardFilter, platform: Platform): boolean {
  const current = normalizeRewardFilter(filter, platform);
  return current.favouriteKinds.length === 0 && current.kinds.length === 0;
}

/** The filter in a few words: only what is narrowed, kinds first and then the
 * subscription mode ("Badges, Emotes · no sub"), or "All rewards". When the
 * Queue groups farm different kinds the kinds read "Mixed types": naming each
 * group's kinds would not fit the button. Farming only pins names the pinned
 * kinds; the menu adds "pinned only" after everything else. */
export function rewardFilterLabel(filter: RewardFilter, platform: Platform, t: TFunction): string {
  const current = normalizeRewardFilter(filter, platform);
  const all = PLATFORM_REWARD_KINDS[platform].length;
  const mode = MODE_LABEL_KEYS[current.subscriptions];
  const named = (kinds: readonly RewardKind[]) =>
    kinds.length === all
      ? t("rewardFilterAllKinds")
      : kinds.map((kind) => t(KIND_SHORT_KEYS[kind])).join(", ");
  let kinds: string;
  if (farmsPinnedOnly(current, platform)) {
    if (current.pinnedKinds.length === all && !mode) return t("rewardFilterAll");
    kinds = named(current.pinnedKinds);
  } else if (!isRewardFilterNarrowed(current, platform)) {
    return t("rewardFilterAll");
  } else {
    kinds = rewardGroupsDiffer(current, platform)
      ? t("rewardFilterMixedTypes")
      : named(current.kinds);
  }
  return mode ? `${kinds} · ${t(mode)}` : kinds;
}

function GroupHeading({ group }: { group: RewardGroup }): React.ReactElement {
  const t = useT();
  const iconClass = "shrink-0 text-zinc-700 dark:text-zinc-200";
  const icon =
    group === "pinned" ? (
      <Pin size={15} strokeWidth={2.25} aria-hidden className={iconClass} />
    ) : group === "favourite" ? (
      <Star size={15} aria-hidden className="shrink-0 fill-amber-400 text-amber-500" />
    ) : (
      <ListOrdered size={15} strokeWidth={2.25} aria-hidden className={iconClass} />
    );
  // Every heading reserves two lines, so the three line up whatever a
  // translation wraps to.
  return (
    <span className="flex flex-col items-center gap-1 text-center">
      {icon}
      <span className="line-clamp-2 min-h-[2lh] leading-tight [overflow-wrap:anywhere]">
        {t(GROUP_KEYS[group])}
      </span>
    </span>
  );
}

/** Which reward kinds each Queue group farms (#932): kinds as rows, the
 * Queue's groups as columns, in Queue order. An empty column farms nothing
 * from its group, so farming only pins is the favourite and other columns
 * left empty. The grid as a whole keeps one kind, so something is always
 * farmed. */
function RewardKindsGrid({
  platform,
  filter,
  onChange,
}: {
  platform: Platform;
  filter: RewardFilter;
  onChange(filter: RewardFilter): void;
}): React.ReactElement {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const available = PLATFORM_REWARD_KINDS[platform];
  const ticked = REWARD_GROUPS.reduce(
    (count, group) => count + rewardGroupKinds(filter, group).length,
    0,
  );
  return (
    <div className="space-y-1">
      <div id={titleId} className={SECTION_TITLE_CLASS}>
        {t("rewardKindsTitle")}
      </div>
      <p id={hintId} className={HINT_CLASS}>
        {t("rewardKindsGroupsDescription")}
      </p>
      <table
        aria-labelledby={titleId}
        aria-describedby={hintId}
        data-reward-kinds-grid=""
        className="w-full table-fixed border-separate border-spacing-0"
      >
        <thead>
          <tr>
            <td />
            {REWARD_GROUPS.map((group) => (
              <th
                key={group}
                scope="col"
                data-reward-group={group}
                className="w-16 px-0.5 pb-1.5 align-top text-[10px] font-semibold text-zinc-500 dark:text-zinc-400"
              >
                <GroupHeading group={group} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {available.map((kind) => (
            <tr key={kind} className="group/row">
              <th
                scope="row"
                className="truncate rounded-s-md py-1 ps-1 text-start text-[11.5px] font-normal text-zinc-700 group-hover/row:bg-[var(--ink-soft)] dark:text-zinc-200"
              >
                {t(KIND_KEYS[kind])}
              </th>
              {REWARD_GROUPS.map((group, index) => {
                const kinds = rewardGroupKinds(filter, group);
                const checked = kinds.includes(kind);
                return (
                  <td
                    key={group}
                    className={cn(
                      "py-1 text-center group-hover/row:bg-[var(--ink-soft)]",
                      index === REWARD_GROUPS.length - 1 && "rounded-e-md",
                    )}
                  >
                    <Checkbox.Root
                      checked={checked}
                      // The last kind left in the grid stays: something is
                      // always farmed.
                      disabled={checked && ticked === 1}
                      aria-label={t("rewardKindForGroup", [
                        t(KIND_KEYS[kind]),
                        t(GROUP_KEYS[group]),
                      ])}
                      data-reward-group={group}
                      data-reward-kind={kind}
                      onCheckedChange={(value) =>
                        onChange(
                          withRewardGroupKinds(
                            filter,
                            group,
                            REWARD_KINDS.filter((entry) =>
                              entry === kind ? value : kinds.includes(entry),
                            ),
                          ),
                        )
                      }
                      className="group inline-flex cursor-default rounded-[5px] align-middle outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[disabled]:cursor-not-allowed"
                    >
                      <span className={BOX_CLASS}>
                        <Checkbox.Indicator className="flex">
                          <Check size={10} strokeWidth={3} aria-hidden />
                        </Checkbox.Indicator>
                      </span>
                    </Checkbox.Root>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The two questions of the reward filter: which kinds each Queue group farms,
 * and what to do with rewards that need a subscription. Shared by the Queue
 * menu and Settings, so both edit the one setting the same way. The Queue menu
 * lays the two out side by side, so it renders each part on its own. */
export function RewardFilterFields({
  platform,
  filter,
  showSubscriptions,
  onChange,
  parts = "both",
}: {
  platform: Platform;
  filter: RewardFilter;
  // Whether to ask the subscription question (showsSubscriptionChoice).
  showSubscriptions: boolean;
  onChange(filter: RewardFilter): void;
  parts?: "both" | "kinds" | "subscriptions";
}): React.ReactElement {
  const t = useT();
  const modesId = useId();
  const modesHintId = useId();
  const current = normalizeRewardFilter(filter, platform);
  return (
    <div className="space-y-3">
      {parts !== "subscriptions" ? (
        <RewardKindsGrid platform={platform} filter={current} onChange={onChange} />
      ) : null}
      {parts !== "kinds" && showSubscriptions ? (
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
 * filter narrows; the menu edits the same per-platform setting as Settings:
 * the kinds grid on the left, the other questions on the right.
 *
 * It is non-modal, like Dropdown: a modal popover locks page scroll by
 * restyling the body, and every body restyle makes Chrome re-measure the
 * extension popup. So any scroll outside the menu closes it
 * (useCloseOnOutsideScroll). */
export function RewardFilterMenu({
  platform,
  filter,
  showSubscriptions,
  unlinkedCampaigns,
  onChange,
  onUnlinkedCampaignsChange,
}: {
  platform: Platform;
  filter: RewardFilter;
  showSubscriptions: boolean;
  unlinkedCampaigns: UnlinkedCampaignMode;
  onChange(filter: RewardFilter): void;
  onUnlinkedCampaignsChange(value: UnlinkedCampaignMode): void;
}): React.ReactElement {
  const t = useT();
  const [portalRef, container] = usePortalContainer();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideScroll(open, () => setOpen(false), popupRef, container);
  // The unlinked mode changes what is farmed as much as the filter does, and
  // the closed button is the only place the Queue says so.
  const unlinkedChanged = unlinkedCampaigns !== DEFAULT_UNLINKED_CAMPAIGN_MODE;
  const pinnedOnly = farmsPinnedOnly(filter, platform);
  const narrowed = unlinkedChanged || isRewardFilterNarrowed(filter, platform);
  const unlinkedLabelKey = UNLINKED_MODE_LABEL_KEYS[unlinkedCampaigns];
  const label = [
    rewardFilterLabel(filter, platform, t),
    ...(unlinkedLabelKey ? [t(unlinkedLabelKey)] : []),
    ...(pinnedOnly ? [t("rewardFilterPinnedOnly")] : []),
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
              "nice-scroll max-h-[var(--available-height)] w-[33rem] max-w-[var(--available-width)] space-y-2 overflow-y-auto overscroll-contain p-3 shadow-lg",
            )}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_12.5rem] gap-x-4">
              <RewardFilterFields
                platform={platform}
                filter={filter}
                showSubscriptions={showSubscriptions}
                onChange={onChange}
                parts="kinds"
              />
              <div className="space-y-2 border-s border-zinc-200 ps-4 dark:border-zinc-800">
                {showSubscriptions ? (
                  <RewardFilterFields
                    platform={platform}
                    filter={filter}
                    showSubscriptions={showSubscriptions}
                    onChange={onChange}
                    parts="subscriptions"
                  />
                ) : null}
                <div
                  className={cn(
                    showSubscriptions && "border-t border-zinc-200 pt-2 dark:border-zinc-800",
                  )}
                >
                  <UnlinkedCampaignsField
                    value={unlinkedCampaigns}
                    onChange={onUnlinkedCampaignsChange}
                  />
                </div>
              </div>
            </div>
            {narrowed ? (
              <div className="flex justify-end border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
                <button
                  type="button"
                  data-reward-filter-reset=""
                  // Reset clears everything the button names: the unlinked
                  // mode too.
                  onClick={() => {
                    onChange(defaultRewardFilter(platform));
                    if (unlinkedChanged) onUnlinkedCampaignsChange(DEFAULT_UNLINKED_CAMPAIGN_MODE);
                  }}
                  className="shrink-0 rounded-md px-1 py-1 text-start text-[11.5px] font-semibold text-zinc-800 underline decoration-zinc-300 underline-offset-2 outline-none hover:bg-[var(--ink-soft)] hover:decoration-current focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-100 dark:decoration-zinc-600"
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
