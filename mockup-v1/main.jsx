import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StreamaxxerMockup from "./streamaxxer_minimal_ui_mockup.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <StreamaxxerMockup />
  </StrictMode>
);
