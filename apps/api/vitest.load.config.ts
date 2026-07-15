import { defineConfig } from "vitest/config";

// Load and soak tests — runs nightly and before releases.
export default defineConfig({
  test: {
    include: ["src/**/*.load.test.ts"],
    passWithNoTests: false,
    globals: false,
    environment: "node",
    testTimeout: 300_000,
  },
});
