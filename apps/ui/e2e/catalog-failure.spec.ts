import { expect, test } from "@playwright/test";
import { catalogFailureFixture } from "./fixtures/catalog.js";
import { mockCatalog } from "./support/mock-api.js";

// docs/ui-design/01_UI要求・画面設計.md §6 「一覧APIの初期取得に失敗した場合は
// 編成・戦闘開始を無効にし...手動再読込を表示する」(UI-AC-016). Regression
// fixture: "Catalog failure" per Issue #98's deliverables.
test("disables formation editing and offers a manual reload when the Catalog fetch fails", async ({
  page,
}) => {
  await mockCatalog(page, { status: 500, body: catalogFailureFixture });
  await page.goto("./");

  await expect(page.getByRole("button", { name: "再読込" })).toBeVisible();
  await expect(page.getByRole("button", { name: /にユニットを追加/ })).toHaveCount(0);
});
