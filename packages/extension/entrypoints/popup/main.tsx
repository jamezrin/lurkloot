import { createRoot } from "react-dom/client";
import "@lurkloot/popup-ui/styles.css";
import { PopupApp } from "./app";
import { suppressPhantomResize } from "../../src/core/popupResize";

// Must run before React mounts: dnd-kit registers its own `resize` listener
// when a drag starts, and window listeners fire in registration order.
suppressPhantomResize(window);

// Thin extension bootstrap. All popup UI lives in ./app so it can also be
// imported and rendered standalone (with mock data) by the marketing landing
// page. The URL-driven screenshot/promo modes here are used by the capture
// scripts (scripts/capture-store-*.mjs).
createRoot(document.getElementById("root")!).render(
  <PopupApp />,
);
