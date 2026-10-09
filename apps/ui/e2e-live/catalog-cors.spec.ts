import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { liveAuthorizationHeaders, seedLiveAccessKey } from "./support/access-key.js";
import { LIVE_CATALOG_URL } from "./support/constants.js";

interface CatalogFetchResult {
  readonly status: number;
  readonly etag: string | null;
  readonly catalogRevision: string;
}

async function fetchCatalog(page: Page, ifNoneMatch?: string): Promise<CatalogFetchResult> {
  return page.evaluate(
    async ({ url, etag, authorization }) => {
      const headers: Record<string, string> = { Accept: "application/json", ...authorization };
      if (etag) {
        headers["If-None-Match"] = etag;
      }
      const response = await fetch(url, { headers });
      const responseEtag = response.headers.get("ETag");
      if (response.status === 304) {
        return { status: response.status, etag: responseEtag, catalogRevision: "" };
      }
      const body = (await response.json()) as { catalogRevision: string };
      return { status: response.status, etag: responseEtag, catalogRevision: body.catalogRevision };
    },
    { url: LIVE_CATALOG_URL, etag: ifNoneMatch, authorization: liveAuthorizationHeaders() },
  );
}

test.beforeEach(async ({ page }) => {
  await seedLiveAccessKey(page);
});

// UI-E2E-LIVE-001: Pages相当originからOPTIONS preflightが成功する。
// UI-E2E-LIVE-005: 一覧APIのETag/304と選択可否を確認する。
//
// A conditional GET (If-None-Match is not a CORS-safelisted request header)
// forces the browser to send a real OPTIONS preflight before the GET, so a
// successful 304 here proves both the preflight and the conditional
// revalidation succeeded from this exact deployed origin — a misconfigured
// CORS_ALLOWED_ORIGINS would surface as a rejected fetch() here, not a
// silently missing header.
test("fetches the Catalog from the deployed origin and revalidates it with ETag/304", async ({
  page,
}) => {
  await page.goto("./");

  const first = await fetchCatalog(page);
  expect(first.status).toBe(200);
  expect(first.etag).toBeTruthy();
  expect(first.catalogRevision.length).toBeGreaterThan(0);

  const second = await fetchCatalog(page, first.etag as string);
  expect(second.status).toBe(304);
});

// UI-E2E-LIVE-006: アクセスキーを要求する配備で、キーなしの一覧取得がPages originから
// 401として読める（CORS headerが付き、UIがキー入力へ誘導できる）。
test("rejects a Catalog fetch without the access key with a CORS-readable 401", async ({
  page,
}) => {
  test.skip(!liveAuthorizationHeaders()["Authorization"], "access key is not configured");
  await page.goto("./");

  const status = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    return response.status;
  }, LIVE_CATALOG_URL);

  expect(status).toBe(401);
});
