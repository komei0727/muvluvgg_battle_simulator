import { defineConfig } from "vitest/config";

// End-to-end tests (HTTP → Worker → Battle) — runs on main branch and releases.
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    passWithNoTests: false,
    globals: false,
    environment: "node",
  },
});
