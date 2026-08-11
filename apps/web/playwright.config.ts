import { defineConfig, devices } from "@playwright/test";

const PORT = 5183;

/**
 * E2E harness for the deferred Playwright gap noted in .github/workflows/ci.yml:
 * driving the real PWA needs either `vercel dev` (Blob token, VAPID keys,
 * Postgres — heavy/flaky in CI) or a parallel mock-API harness. This is the
 * mock-API harness option: `vite dev` serves the real app (VitePWA's
 * `devOptions` isn't enabled, so no service worker registers in dev mode —
 * one less moving part), and every spec intercepts `/api/**` at the browser
 * network layer via `page.route` (see e2e/mocks.ts) instead of hitting a
 * real backend. The app is local-first (Dexie is the source of truth —
 * see docs/sync-design.md), so every route exercised here works entirely
 * off mocked/absent network responses, the same way the device itself
 * behaves offline.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // A narrow viewport, not a full device profile: this app's primary nav
  // (App.tsx's bottom tab bar) is `md:hidden`-only-above, i.e. it exists
  // solely below Tailwind's `md` breakpoint (768px) — matching the
  // README's "field instrument" framing, this is a phone-first PWA with
  // no desktop-width nav equivalent. A full "Desktop Chrome" viewport
  // would render that bar present-but-invisible, so every nav-driving
  // spec would hang waiting to click a hidden element.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
