import { defineConfig, devices } from "@playwright/test";

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
      // Not a real endpoint: this foundation shell never calls the API yet
      // (Issue #94 adds the Catalog client), so only URL validity matters here.
      VITE_API_BASE_URL: "https://e2e-preview.invalid.example",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
