import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "./app/router";
import "./styles/base.css";
import "./styles/tokens.css";

const chunkReloadMarker = "hxaxd-stale-chunk-reload";
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const previous = Number(window.sessionStorage.getItem(chunkReloadMarker) ?? 0);
  if (Date.now() - previous < 30_000) return;
  window.sessionStorage.setItem(chunkReloadMarker, String(Date.now()));
  window.location.reload();
});
window.setTimeout(() => window.sessionStorage.removeItem(chunkReloadMarker), 10_000);

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js");
  });
}
