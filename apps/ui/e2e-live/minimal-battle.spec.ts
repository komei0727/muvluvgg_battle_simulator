import { expect, test } from "@playwright/test";
import { LIVE_CATALOG_URL } from "./support/constants.js";
import { fillMinimalLiveFormation } from "./support/formation.js";

// UI-E2E-LIVE-002: 最小1対1をPOSTし200を表示する。
// UI-E2E-LIVE-003: `X-Request-Id`をresponse headerから読める。
// UI-E2E-LIVE-004: 一覧API Catalog revisionと戦闘API response revisionを比較する。
//
// Runs against whatever the live Catalog currently offers rather than a
// fixed fixture (06_UIテスト戦略.md §6「乱数結果の具体値を固定しない」), so
// this only asserts completion, unit-availability, and revision/traceability
// invariants — never a specific outcome or damage value.
test("runs a minimal live battle and shows a Catalog-revision-consistent, traceable result", async ({
  page,
}) => {
  await page.goto("./");

  const catalogRevision = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const body = (await response.json()) as { catalogRevision: string };
    return body.catalogRevision;
  }, LIVE_CATALOG_URL);
  expect(catalogRevision.length).toBeGreaterThan(0);

  await fillMinimalLiveFormation(page);
  await page.getByRole("button", { name: "戦闘を開始" }).click();

  // Cloud Run scale-to-zero cold start plus Worker warm-up can push first
  // response well past typical UI timeouts (運用手順.md「M4.5配備構成」).
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible({ timeout: 90_000 });

  await expect(page.getByText(/^Request ID: /)).toBeVisible();
  await expect(page.getByText(`Catalog revision: ${catalogRevision}`)).toBeVisible();
});
