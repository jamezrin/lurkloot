import type { ReviewStore } from "@lurkloot/popup-ui";

// The store this build is installed from, for the rate nudge's review link.
// Every extension surface that mounts popup-ui passes it: an adapter that left
// it out would fall back to the Chrome Web Store, wrong in the Firefox build.
export function reviewStoreFor(firefox: boolean): ReviewStore {
  return firefox ? "firefox-add-ons" : "chrome-web-store";
}

export const EXTENSION_REVIEW_STORE: ReviewStore = reviewStoreFor(Boolean(import.meta.env.FIREFOX));
