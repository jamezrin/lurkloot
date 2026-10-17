import type React from "react";
import type { AccountProgressPoll, PlatformAccountProgress } from "@lurkloot/shared/models";
import { KickAccountProgressView } from "./kickAccountProgress";

// What each platform shows of its account progress beside its switch. A
// platform with no entry shows nothing; one that adds progress adds its own
// member to PlatformAccountProgress and its own view here, with its own
// meaning. The strip itself never looks inside.
type AccountProgressViews = {
  [P in PlatformAccountProgress["platform"]]: React.ComponentType<{
    progress: Extract<PlatformAccountProgress, { platform: P }>;
  }>;
};

const ACCOUNT_PROGRESS_VIEWS: AccountProgressViews = {
  kick: KickAccountProgressView,
};

// The last good read, while the platform's session is signed in: a value kept
// from before a sign-out would describe an account the popup cannot vouch for.
// Only in the wide layout: in the narrow one the strip has no room left for it
// beside the watching lines, the source chip and the switch.
export function AccountProgressSlot({
  poll,
  signedIn,
}: {
  poll?: AccountProgressPoll;
  signedIn: boolean;
}): React.ReactElement | null {
  const progress = poll?.progress;
  if (!signedIn || !progress) return null;
  const View = ACCOUNT_PROGRESS_VIEWS[progress.platform] as React.ComponentType<{
    progress: PlatformAccountProgress;
  }>;
  return (
    <div data-account-progress-slot className="@[560px]:flex hidden shrink-0">
      <View progress={progress} />
    </div>
  );
}
