import { defineConfig } from "vitest/config";

// Worker and HTTP integration tests — runs on main branch and selected PRs.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    globals: false,
    environment: "node",
  },
});
