import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../design-tokens/tokens.css";
import "./app.css";
import "./look.css";
import "./ui/ui.css";
import { App } from "./App";
import { registerServiceWorker } from "./Notify";
import { applyTheme } from "./theme";

applyTheme();
// Shows pushes; caches nothing. Registered on load so a subscription made earlier keeps working.
void registerServiceWorker();

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
