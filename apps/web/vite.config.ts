import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Icons under public/icons are placeholders until the visual design pass
// (docs/plan Build Approach step 2) replaces them with real artwork.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "House Maintenance",
        short_name: "House",
        description: "Meter readings and maintenance tracking for the house.",
        // Aligned with the "Field Instrument" design tokens (index.css):
        // graphite ink for the browser/splash chrome, cream bg while the
        // app shell loads — matches the generated icon artwork.
        theme_color: "#1e1b16",
        background_color: "#f4f1ea",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // App shell + static assets are precached; API/sync calls are
        // never cached here — Dexie is the offline data layer, not the
        // service worker cache. See docs/sync-design.md.
        navigateFallback: "/index.html",
        // woff2/woff included so the self-hosted design typefaces are
        // available fully offline, not just app code — see the design
        // notes in src/index.css.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
