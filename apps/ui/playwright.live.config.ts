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

// The post-deploy correctness job (`pages-smoke` in main.yml) benefits from a
// CI retry for ordinary flakiness. The cold-start job
// (pages-live-smoke-cold-start.yml) must not: if the first request to a cold
// instance times out and Playwright's default CI retry re-runs the test
// against the now-warm instance, the run reports success even though the
// actual acceptance criterion — a cold-started instance serving the request —
// was never met (PRレビュー指摘 #125 4回目レビュー P1). That workflow sets
// LIVE_SMOKE_RETRIES=0 to force the first attempt to be the only attempt.
const retriesOverride = process.env["LIVE_SMOKE_RETRIES"];
const retries = retriesOverride !== undefined ? Number(retriesOverride) : process.env["CI"] ? 1 : 0;

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries,
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
