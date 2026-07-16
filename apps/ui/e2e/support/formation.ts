import type { Page } from "@playwright/test";

// Ally and enemy FormationEditor instances render an identical accessible
// name ("前衛1にユニットを追加") for their FRONT/column-0 slot. Filling the
// ally slot first changes its name (e.g. "前衛1: アライアルファを変更"), so
// the remaining match after that click is unambiguously the enemy slot —
// mirrors src/app/BattleSimulatorPage.test.tsx's setUpMinimalFormation.
export async function fillMinimalFormation(
  page: Page,
  allyUnitDisplayName: string,
  enemyUnitDisplayName: string,
): Promise<void> {
  await page.getByRole("button", { name: "前衛1にユニットを追加" }).first().click();
  await page.getByRole("button", { name: `${allyUnitDisplayName}を選択` }).click();

  await page.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: `${enemyUnitDisplayName}を選択` }).click();
}
