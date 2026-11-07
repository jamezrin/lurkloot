import { createRoot } from "react-dom/client";
import "./styles.css";
import { readLanguageOverride } from "./adapter";
import { createControlPlaneClient, sessionTokenStore } from "./api";
import { App } from "./App";
import { storageOrMemory } from "./browserStorage";
import { loadAppCatalogs } from "./i18n";
import { createTokenPromptBridge } from "./tokenPrompt";

const session = storageOrMemory(() => sessionStorage);
const local = storageOrMemory(() => localStorage);
const tokens = createTokenPromptBridge();
const client = createControlPlaneClient({
  tokenStore: sessionTokenStore(session),
  promptToken: tokens.prompt,
});
const uiLanguage = navigator.language;
const catalogs = await loadAppCatalogs(readLanguageOverride(local), uiLanguage);

createRoot(document.getElementById("root")!).render(
  <App
    client={client}
    subscribeTokenRequests={tokens.subscribe}
    initialCatalogs={catalogs}
    storage={local}
    uiLanguage={uiLanguage}
  />,
);
