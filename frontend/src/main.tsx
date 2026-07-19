import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "./app/router";
import "./styles/base.css";
import "./styles/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
