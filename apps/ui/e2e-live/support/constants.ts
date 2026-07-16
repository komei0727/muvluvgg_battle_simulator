// playwright.live.config.ts already asserts this is set before any test can
// run, so a non-null read here is safe.
export const LIVE_API_BASE_URL = process.env["LIVE_API_BASE_URL"] as string;
export const LIVE_CATALOG_URL = `${LIVE_API_BASE_URL}/api/v1/battle-simulation-catalog`;
