import type { Page } from "@playwright/test";
import { CATALOG_URL, SIMULATION_URL } from "./constants.js";

export interface MockResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

// A cross-origin fetch() only exposes CORS-safelisted response headers to
// JavaScript unless Access-Control-Expose-Headers names the rest — the same
// origin-page-vs-Cloud-Run-API split this app runs under in production. The
// real API exposes exactly these three
// (docs/ui-design/07_UI実装・拡張計画.md §3 「X-Request-Id、Retry-After、
// ETagをexposeする」), so the mock must too, or api-client.ts's
// response.headers.get("Retry-After"/"X-Request-Id"/"ETag") reads null here
// even though route.fulfill sent the header — a failure mode that would
// never surface against same-origin dev tooling.
const EXPOSED_HEADERS = "X-Request-Id, Retry-After, ETag";

// Serves a single fixed response for every GET to the Catalog endpoint —
// sufficient for these specs, none of which reload the Catalog mid-test.
export async function mockCatalog(page: Page, response: MockResponse): Promise<void> {
  await page.route(CATALOG_URL, async (route) => {
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS, ...response.headers },
      body: JSON.stringify(response.body),
    });
  });
}

// Serves `responses` in order across successive POSTs (submit, then rerun,
// ...), repeating the last entry once exhausted. This lets a single spec
// cover "succeeds, then a rerun fails" (UI-E2E-004) without re-registering
// the route mid-test.
export async function mockSimulationSequence(
  page: Page,
  responses: readonly MockResponse[],
): Promise<void> {
  let callIndex = 0;
  await page.route(SIMULATION_URL, async (route) => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    if (response === undefined) {
      throw new Error("mockSimulationSequence requires at least one response.");
    }
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: { "Access-Control-Expose-Headers": EXPOSED_HEADERS, ...response.headers },
      body: JSON.stringify(response.body),
    });
  });
}
