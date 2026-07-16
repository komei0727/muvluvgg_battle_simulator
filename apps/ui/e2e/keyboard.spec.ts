import { expect, test } from "@playwright/test";
import { battleSuccessFixture } from "./fixtures/battle-success.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { mockCatalog, mockSimulationSequence } from "./support/mock-api.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

// UI-E2E-008: keyboardだけでunit選択から結果tabまで操作する。
//
// This uses locator.focus() to position focus before each interaction
// instead of counting raw Tab keystrokes through the whole page: the exact
// global tab order is a manual audit item
// (docs/ui-design/06_UIテスト戦略.md §8 手動「keyboard focus順」), while what
// this automated scenario must prove is that every step — opening a
// dialog, selecting an item, submitting, switching detail tabs — is
// reachable and operable via keyboard alone (Enter/Space/Arrow keys), with
// no mouse-only interaction and no focus trap left dangling.
test("completes unit selection through the details tabs using only the keyboard", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleSuccessFixture }]);
  await page.goto("./");

  const allySlot = page.getByRole("button", { name: "前衛1にユニットを追加" }).first();
  await allySlot.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "ユニットを選択" })).toBeVisible();
  await expect(page.getByLabel("ユニットを検索")).toBeFocused();

  await page.getByRole("button", { name: "アライアルファを選択" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /前衛1: アライアルファを変更/ })).toBeFocused();

  const enemySlot = page.getByRole("button", { name: "前衛1にユニットを追加" });
  await enemySlot.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "エネミーアルファを選択" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /前衛1: エネミーアルファを変更/ })).toBeFocused();

  const submitButton = page.getByRole("button", { name: "戦闘を開始" });
  await submitButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  const eventsTab = page.getByRole("tab", { name: "時系列イベント" });
  await eventsTab.focus();
  await page.keyboard.press("ArrowRight");
  const transitionsTab = page.getByRole("tab", { name: "状態遷移" });
  await expect(transitionsTab).toBeFocused();
  await expect(transitionsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "状態遷移" })).toBeVisible();
});
