// Which store an install button sends a visitor to. The HTML ships the Chrome
// Web Store link, which every crawler and every visitor without scripts gets;
// in Firefox the page swaps it for the Firefox Add-ons listing.

export interface InstallLinks {
  chrome: string;
  firefox: string;
}

// Firefox and its Android build send "Firefox/<version>". Chromium browsers
// never do; Firefox on iOS sends "FxiOS" and cannot install add-ons.
export function isFirefox(userAgent: string): boolean {
  return /\bFirefox\/\d/.test(userAgent);
}

export function installLinkFor(userAgent: string, links: InstallLinks): string {
  return isFirefox(userAgent) ? links.firefox : links.chrome;
}
