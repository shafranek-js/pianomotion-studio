import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";
import { applicationBuildId, registerServiceWorker } from "./pwa";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

document.documentElement.dataset.releaseBuildId = applicationBuildId();

if (import.meta.env.PROD) {
  void registerServiceWorker();
}
