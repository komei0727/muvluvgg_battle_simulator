// Shared with playwright.config.ts's webServer.env.VITE_API_BASE_URL: the
// built preview server bakes a single API base URL for the whole Playwright
// run, so every spec that mocks network calls must target this same origin
// via page.route (docs/ui-design/06_UIテスト戦略.md §6 「Mock API E2E」).
export const API_BASE_URL = "https://e2e-mock-api.invalid.example";
export const CATALOG_URL = `${API_BASE_URL}/api/v1/battle-simulation-catalog`;
export const SIMULATION_URL = `${API_BASE_URL}/api/v1/battle-simulations`;
