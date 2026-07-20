import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { battleSuccessFixture } from "./fixtures/battle-success.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { mockCatalog, mockSimulationSequence } from "./support/mock-api.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

// Presses real Tab keystrokes — not locator.focus() — until `target` becomes
// document.activeElement, proving the target is actually reachable in the
// page's live tab order (review: PR #124 — locator.focus() can move focus
// to an element regardless of whether a real keyboard user could Tab to it,
// so it is not evidence of keyboard reachability). The exact number of
// presses is not asserted/hardcoded: that would recouple this test to
// incidental markup order. Bounded by maxPresses so an unreachable target
// fails loudly instead of hanging.
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 60): Promise<void> {
  for (let attempt = 0; attempt <= maxPresses; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the target via Tab within ${maxPresses} presses.`);
}

// UI-E2E-008 / UI-NFR-001: keyboardだけでunit選択から結果tabまで操作する。
// 各対象へは実際のTab keystrokeで到達し(tabUntilFocused)、選択・送信・tab
// 切替はEnter/Arrowの実keystrokeで行う。dialogを閉じた後にfocusが起点slotへ
// 戻ることも(programmatic focus()ではなく)アプリ自身の挙動として検証する。
test("reaches every step of unit selection through the details tabs via real Tab/Enter/Arrow keystrokes", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleSuccessFixture }]);
  await page.goto("./");

  const allySlot = page.getByRole("button", { name: "前衛1にユニットを追加" }).first();
  await tabUntilFocused(page, allySlot);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "ユニットを選択" })).toBeVisible();
  await expect(page.getByLabel("ユニットを検索")).toBeFocused();

  const allyItemButton = page.getByRole("button", { name: "アライアルファを選択" });
  await tabUntilFocused(page, allyItemButton);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const allySlotFilled = page.getByRole("button", { name: /前衛1: アライアルファを変更/ });
  await expect(allySlotFilled).toBeFocused();

  const enemySlot = page.getByRole("button", { name: "前衛1にユニットを追加" });
  await tabUntilFocused(page, enemySlot);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "ユニットを選択" })).toBeVisible();

  const enemyItemButton = page.getByRole("button", { name: "エネミーアルファを選択" });
  await tabUntilFocused(page, enemyItemButton);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const enemySlotFilled = page.getByRole("button", { name: /前衛1: エネミーアルファを変更/ });
  await expect(enemySlotFilled).toBeFocused();

  const submitButton = page.getByRole("button", { name: "戦闘を開始" });
  await tabUntilFocused(page, submitButton);
  await page.keyboard.press("Enter");
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  const eventsTab = page.getByRole("tab", { name: "時系列イベント" });
  await tabUntilFocused(page, eventsTab);
  await page.keyboard.press("ArrowRight");
  const transitionsTab = page.getByRole("tab", { name: "状態遷移" });
  await expect(transitionsTab).toBeFocused();
  await expect(transitionsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "状態遷移" })).toBeVisible();

  // PR #154レビュー[P1]: 因果ツリーtabも他tabと同じくArrowだけで到達・選択
  // できることを実keystrokeで検証する(UI-NFR-001)。Home/Endで両端へ移動できる
  // ことも合わせて確認する。
  const causalityTreeTab = page.getByRole("tab", { name: "因果ツリー" });
  await page.keyboard.press("End");
  await expect(causalityTreeTab).toBeFocused();
  await expect(causalityTreeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "因果ツリー" })).toBeVisible();

  await page.keyboard.press("Home");
  await expect(eventsTab).toBeFocused();
  await expect(eventsTab).toHaveAttribute("aria-selected", "true");
});
