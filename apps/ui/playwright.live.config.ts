import { defineConfig, devices } from "@playwright/test";

// Exercises the deployed GitHub Pages origin against the live Cloud Run API
// (06_UIテスト戦略.md §6 "Deployed API E2E", UI-E2E-LIVE-001〜005). Unlike
// playwright.config.ts, this suite makes real network requests — it must
// never mock the API, and it only runs where both URLs are reachable
// (the Pages deploy workflow, Issue #99), never as part of `mise run ui:e2e`.
const pagesUrl = process.env["LIVE_PAGES_URL"];

if (!pagesUrl || !process.env["LIVE_API_BASE_URL"]) {
  throw new Error(
    "playwright.live.config.ts requires LIVE_PAGES_URL and LIVE_API_BASE_URL to be set — " +
      "this suite targets real deployed infrastructure and has no local default.",
  );
}

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: "list",
  // Cloud Run scale-to-zero cold start (min instances 0) plus Catalog/Worker
  // warm-up can take well beyond the default 30s (運用手順.md「M4.5配備構成」).
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: pagesUrl,
    trace: "on-first-retry",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
