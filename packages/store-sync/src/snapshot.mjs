// Writes the dashboard's structure down so the locators that find things in it
// can be tested against the real page, not only against a hand-built imitation.
// The page is the operator's signed-in session, and these files are committed,
// so everything that identifies the person or the session is removed, not
// masked: scripts, styles, hidden inputs, links, image addresses and every
// attribute that is not on the allow list below.

// Runs inside the page. It must stay self-contained because it is serialised
// and evaluated there, so it cannot use anything defined outside it.
export function sanitizeInPage() {
  const KEEP = new Set([
    "id",
    "role",
    "type",
    "for",
    "name",
    "alt",
    "accept",
    "placeholder",
    "maxlength",
    "rows",
    "cols",
    "required",
    "disabled",
    "hidden",
    "tabindex",
    "multiple",
    "readonly",
    "checked",
    "selected",
  ]);
  const DROP_ELEMENTS = [
    "script",
    "style",
    "link",
    "meta",
    "iframe",
    "frame",
    "noscript",
    "object",
    "embed",
    "base",
    "template",
    "canvas",
    "audio",
    "video",
    "source",
    "track",
  ];
  // Only the listing form is kept. The page around it carries the signed-in
  // account, the other items and sites of the publisher, and its own menus.
  const main = document.querySelector("main");
  const root = document.createElement("html");
  const body = document.createElement("body");
  body.append((main ?? document.body).cloneNode(true));
  root.append(body);
  const scrub = (text) =>
    text
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "user@example.invalid")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "00000000-0000-0000-0000-000000000000",
      );

  for (const selector of DROP_ELEMENTS) {
    for (const element of root.querySelectorAll(selector)) element.remove();
  }
  for (const input of root.querySelectorAll('input[type="hidden"]')) input.remove();
  // Options list accounts, sites and languages of this one publisher. They only
  // exist while a menu is open, so nothing the locators need is lost.
  for (const option of root.querySelectorAll('[role="option"]')) option.remove();
  for (const svg of root.querySelectorAll("svg")) svg.replaceChildren();

  let imageNumber = 0;
  const imageIds = new Map();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") element.textContent = element.value;
    const source = tag === "img" ? element.currentSrc || element.getAttribute("src") || "" : "";
    // Read before the attributes go: a field's value follows its attribute until
    // someone edits it.
    const held = tag === "input" ? element.value : "";
    for (const { name } of [...element.attributes]) {
      if (KEEP.has(name) || name.startsWith("aria-")) {
        element.setAttribute(name, scrub(element.getAttribute(name)));
        continue;
      }
      element.removeAttribute(name);
    }
    if (tag === "input" && element.type !== "file") {
      element.setAttribute("value", scrub(held));
    }
    if (tag === "img") {
      // The address names an upload on a private host, so each distinct image
      // becomes a stable stand-in. Equal images stay equal, different ones differ.
      // The part after "=" only sizes the image, so it is not part of its identity.
      const identity = source.split("=")[0];
      if (!imageIds.has(identity)) imageIds.set(identity, `image-${++imageNumber}`);
      element.setAttribute("src", `https://images.example.invalid/${imageIds.get(identity)}=s1280`);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
  const comments = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE) comments.push(node);
    else node.textContent = scrub(node.textContent);
  }
  for (const comment of comments) comment.remove();
  return `<!doctype html>\n${root.outerHTML}\n`;
}
