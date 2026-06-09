import { createRoot } from "react-dom/client";
import "@stream-autopilot/popup-ui/styles.css";
import { PopupApp } from "./app";

// Thin extension bootstrap. All popup UI lives in ./app so it can also be
// imported and rendered standalone (with mock data) by the marketing landing
// page. The URL-driven screenshot/promo modes here are used by the capture
// scripts (scripts/capture-store-*.mjs).
createRoot(document.getElementById("root")!).render(
  <PopupApp />,
);
