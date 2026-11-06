import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * 既定モードは戦術演習（`UI-AC-018`）。通常戦闘モードの画面を見るspecは
 * `page.goto()`の直後にこれを呼ぶ。
 */
export async function openBattleMode(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "通常戦闘" }).click();
}

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

/**
 * 既定のログレベルは`SUMMARY`（Issue #464）。`SUMMARY`実行のレスポンスは時系列
 * イベント・状態遷移・レスポンスJSONを持たないため、詳細タブを開くspecは実行前に
 * これを呼んで詳細ログモードへ切り替える。通常戦闘モード専用 — 演習の単一実行は
 * 常に`DETAILED`で送り、ログレベルの選択そのものを持たない（Issue #539）。
 */
export async function selectDetailedLogLevel(page: Page): Promise<void> {
  await page.getByLabel("ログレベル").selectOption("DETAILED");
}

/** 総力戦タブを開き、Catalogの読込を待つ。 */
export async function openTotalWarMode(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "総力戦" }).click();
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
}

/**
 * 両陣営に2編成ずつ組む。編成2は編成1と同じユニットにして、再登場（R-TWR-02 #1）の
 * 枠を作る。終了時は両陣営とも編成2を表示している。
 */
export async function fillTotalWarFormations(page: Page): Promise<void> {
  for (const [side, region, displayName] of [
    ["ally", /ALLY FORMATION/, "アライアルファ"],
    ["enemy", /ENEMY FORMATION/, "エネミーアルファ"],
  ] as const) {
    const section = page.getByRole("region", { name: region });
    await section.getByRole("button", { name: "前衛1にユニットを追加" }).click();
    await page.getByRole("button", { name: `${displayName}を選択` }).click();
    await page
      .locator(`[data-formation-side='${side}']`)
      .getByRole("button", { name: "編成を追加" })
      .click();
    await section.getByRole("button", { name: "前衛1にユニットを追加" }).click();
    await page.getByRole("button", { name: `${displayName}を選択` }).click();
  }
}
