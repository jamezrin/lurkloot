import { createRoot } from "react-dom/client";
import "./style.css";
import {
  Popup,
  StoreScreenshot,
  PromoTile,
  SCREENSHOT_MODE,
  SCREENSHOT_VARIANT,
  PROMO_MODE,
  PROMO_FORMAT,
} from "./app";

// Thin extension bootstrap. All popup UI lives in ./app so it can also be
// imported and rendered standalone (with mock data) by the marketing landing
// page. The URL-driven screenshot/promo modes here are used by the capture
// scripts (scripts/capture-store-*.mjs).
createRoot(document.getElementById("root")!).render(
  PROMO_MODE ? (
    <PromoTile format={PROMO_FORMAT} />
  ) : SCREENSHOT_MODE ? (
    <StoreScreenshot variant={SCREENSHOT_VARIANT}>
      <Popup />
    </StoreScreenshot>
  ) : (
    <Popup />
  ),
);
