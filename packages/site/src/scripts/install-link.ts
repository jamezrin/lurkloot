// Points every install button at the store for the visitor's browser. See
// installLink.ts for why the HTML carries the Chrome Web Store link.
import { LINKS } from "../consts";
import { installLinkFor } from "../installLink";

const href = installLinkFor(navigator.userAgent, LINKS);
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-install-link]")) {
  link.href = href;
}
