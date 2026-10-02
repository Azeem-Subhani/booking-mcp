import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file boots its own in-memory Postgres (PGlite), which takes a moment.
    testTimeout: 20_000,
  },
});
