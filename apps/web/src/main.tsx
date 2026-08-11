import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Self-hosted (not Google Fonts CDN) so they're bundled and precached by
// the service worker — the app must render correctly with zero network,
// including its typefaces. See src/index.css for the rest of the design
// system these pair with.
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/500-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
