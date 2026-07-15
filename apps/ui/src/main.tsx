import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BattleSimulatorApp } from "./app/BattleSimulatorApp.js";
import { resolveApiBaseUrl } from "./lib/env.js";
import "./styles/global.css";

const apiBaseUrlResult = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, {
  requireHttps: import.meta.env.PROD,
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element is missing from index.html.");
}

createRoot(rootElement).render(
  <StrictMode>
    <BattleSimulatorApp apiBaseUrlResult={apiBaseUrlResult} />
  </StrictMode>,
);
