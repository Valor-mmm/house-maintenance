import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live under e2e/ and run via `npm run test:e2e`
    // (a separate runner) — excluded here so `vitest run` doesn't try to
    // execute them as unit tests.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
