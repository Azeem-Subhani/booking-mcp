import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Closes connections and drops per-test databases after every test.
    setupFiles: ["tests/setup.ts"],
    // Each test gets a fresh database (PGlite, or real Postgres with TEST_DATABASE_URL), which takes a moment.
    testTimeout: 20_000,
  },
});
