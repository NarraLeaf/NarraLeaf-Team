import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../design-tokens/tokens.css";
import "./app.css";
import "./look.css";
import { App } from "./App";
import { applyTheme } from "./theme";

applyTheme();

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
