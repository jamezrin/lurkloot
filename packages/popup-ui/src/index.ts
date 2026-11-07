export {
  Popup,
  POPUP_FRAME_CLASS,
  screenshotVariant,
  type PopupWindowFrame,
} from "./Popup";
// For a host's own views rendered inside the frame (PopupWindowFrame.hostViews).
export { usePopupRuntime, useT } from "./context";
export { cn } from "./primitives";
export { PromoTile, StoreScreenshot } from "./marketing";
export { CriticalFailurePanel } from "./criticalFailure";
export { createDemoPopupAdapter } from "./demo";
export { openHttpsLink } from "./links";
export { COMBINED_DROPS_MEDIA_QUERY } from "./combinedDrops";
export {
  advanceActivityRequestScope,
  applyActivityMutationForRequest,
  applyActivityPage,
  applyActivityPageForRequest,
  beginActivityMutation,
  beginDiagnosticsExport,
  buildActivityCard,
  buildActivityExport,
  buildDiagnosticsExportFilename,
  createActivityMutationSequence,
  createActivityRequestScope,
  createActivityStream,
  createDiagnosticsExportRequest,
  formatActivityEvent,
  isActivityRequestCurrent,
  isDiagnosticsExportCurrent,
  isLatestActivityMutation,
  mergeActivityPages,
} from "./activity.logic";
export type {
  ActivityCard,
  ActivityCardIcon,
  ActivityCardTone,
  DiagnosticsExportRequest,
} from "./activity.logic";
export type {
  OnboardingAudience,
  PopupAdapter,
  PopupInitialState,
  ReviewStore,
  ScreenshotVariant,
} from "./types";
export type { PopupHostView, PopupView } from "./shell";
export {
  DEFAULT_HOST_CAPABILITIES,
  type PopupHostCapabilities,
  type PopupHostCapability,
} from "./hostCapabilities";
export { variantShowsPopup } from "./types";
export { SCREENSHOT_VARIANTS } from "./constants";

export { StoreArtwork, StorePromo, type StoreStory } from "./storeArtwork";
export { buildActivityTimeline, groupTimelineByDay, type TimelineBlock } from "./activity.logic";
export {
  buildRewardView,
  isRewardEvent,
  type RewardChip,
  type RewardLayout,
  type RewardView,
} from "./activityRewards";
