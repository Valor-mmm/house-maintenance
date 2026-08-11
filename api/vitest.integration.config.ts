import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    // These hit a real Postgres and can take longer than unit-test defaults.
    testTimeout: 15_000,
  },
});
