import { expect, test } from "@playwright/test";
import {
  battleCapacityErrorFixture,
  battleValidationErrorFixture,
} from "./fixtures/battle-errors.js";
import { battleSuccessFixture } from "./fixtures/battle-success.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { fillMinimalFormation } from "./support/formation.js";
import { mockCatalog, mockSimulationSequence } from "./support/mock-api.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

// UI-E2E-003: API 422で該当unit slotを強調する。
test("highlights the ally slot named by a 422 violation path", async ({ page }) => {
  await mockSimulationSequence(page, [{ status: 422, body: battleValidationErrorFixture }]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();

  await expect(page.getByText("配置が不正です。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /前衛1: アライアルファを変更.*入力エラーがあります/ }),
  ).toBeVisible();
});

// UI-E2E-004: API 503で前回結果を保持し再試行操作を表示する。
test("keeps the previous success result visible and offers retry after a 503 rerun", async ({
  page,
}) => {
  await mockSimulationSequence(page, [
    { status: 200, body: battleSuccessFixture },
    { status: 503, body: battleCapacityErrorFixture, headers: { "Retry-After": "5" } },
  ]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  const submitButton = page.getByRole("button", { name: "戦闘を開始" });
  await submitButton.click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  await submitButton.click();

  await expect(
    page.getByText("サーバーが混雑しています。しばらく待って再試行してください。"),
  ).toBeVisible();
  await expect(page.getByText("Retry-After: 5s")).toBeVisible();
  // The previous success is retained underneath the error, not discarded
  // (docs/ui-design/01_UI要求・画面設計.md §6.2 "新しい実行が失敗した場合、
  // 前回成功結果は残し、その上にエラーを表示する").
  await expect(page.getByText("前回成功結果を保持しています。")).toBeVisible();
  await expect(page.getByText("Battle ID: battle-e2e-001")).toBeVisible();
  // The primary submit action is still available to retry.
  await expect(submitButton).toBeEnabled();
});
