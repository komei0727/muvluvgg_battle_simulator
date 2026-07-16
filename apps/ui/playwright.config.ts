import { defineConfig, devices } from "@playwright/test";
import { API_BASE_URL } from "./e2e/support/constants.js";

// Mirrors the GitHub Pages project-site path (02_フロントエンドアーキテクチャ設計.md §6.1).
// The Pages deploy workflow (Issue #99) will source this from CI configuration;
// this E2E foundation pins it so `pnpm run test:e2e` reproduces the same path.
const basePath = "/muvluvgg_battle_simulator/";
const port = 4173;
const baseURL = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --port ${port} --strictPort --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    env: {
      VITE_BASE_PATH: basePath,
      // Never a real endpoint: every spec mocks this origin via page.route
      // (e2e/support/mock-api.ts). A single webServer/build means every spec
      // shares this one baked-in base URL — it cannot vary per test file.
      VITE_API_BASE_URL: API_BASE_URL,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
