import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FluxDesignerApp from "./flux/FluxDesignerApp";
import { resolveUiRoute } from "./route";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("EvlEDA UI root element was not found.");
const route = resolveUiRoute(window.location.pathname);
document.title = route.title;

createRoot(root).render(
  <StrictMode>
    <a className="skip-link" href={route.skipTarget}>{route.skipLabel}</a>
    {route.kind === "flux" ? <FluxDesignerApp /> : <App />}
  </StrictMode>
);
