import type { Page } from "@playwright/test";

// The live Catalog's real definitions and display names are not known at
// spec-write time (unlike the mock-API e2e fixtures), so this selects
// whichever unit the dialog lists first instead of matching by
// display name — mirrors apps/ui/e2e/support/formation.ts's ally-then-enemy
// ordering (filling the ally slot first disambiguates the remaining
// "前衛1にユニットを追加" match as the enemy slot).
async function selectFirstAvailableUnit(page: Page): Promise<void> {
  const selectButtons = page.getByRole("button", { name: /を選択$/ });
  const count = await selectButtons.count();
  for (let index = 0; index < count; index += 1) {
    const button = selectButtons.nth(index);
    if (await button.isEnabled()) {
      await button.click();
      return;
    }
  }
  throw new Error("No unit was found in the live Catalog's unit selection dialog.");
}

/**
 * 既定モードは戦術演習（`UI-AC-018`）。live smokeは通常戦闘の縦切りを見るため、
 * 編成を触る前にモードを切り替える —— 演習モードのままでは実行ボタンが
 * 「戦術演習を開始」になり、「戦闘を開始」を待って必ずタイムアウトする
 * （mock APIのe2eが`openBattleMode`で同じ切替をしているのと同じ理由）。
 */
export async function openLiveBattleMode(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "通常戦闘" }).click();
}

export async function fillMinimalLiveFormation(page: Page): Promise<void> {
  await openLiveBattleMode(page);
  await page.getByRole("button", { name: "前衛1にユニットを追加" }).first().click();
  await selectFirstAvailableUnit(page);

  await page.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await selectFirstAvailableUnit(page);
}
