import { expect, test } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { totalWarSuccessFixture } from "./fixtures/total-war-success.js";
import { TOTAL_WAR_URL } from "./support/constants.js";
import { fillTotalWarFormations, openTotalWarMode } from "./support/formation.js";
import { mockCatalog, mockTotalWar } from "./support/mock-api.js";

// docs/ui-design/06_UIテスト戦略.md §6 「Mock API E2E」: 総力戦モードの縦切り
// （モード切替 → 両陣営2編成 → 実行 → 結果ヘッダー・戦闘履歴・ユニット別表）。
test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
  await mockTotalWar(page, { status: 200, body: totalWarSuccessFixture });
});

// UI-E2E-020: UI-AC-061, UI-AC-062。
test("runs a two-formation total war and shows the outcome, battle history and per-formation roster", async ({
  page,
}) => {
  await page.goto("./");
  await openTotalWarMode(page);
  await fillTotalWarFormations(page);

  // 編成2は編成1と同じユニットなので再登場（R-TWR-02 #1）の印が付く。
  await expect(page.getByText("再登場 −99%").first()).toBeVisible();

  const totalWarRequest = page.waitForRequest(TOTAL_WAR_URL);
  await page.getByRole("button", { name: "総力戦を開始" }).click();
  const payload = JSON.parse((await totalWarRequest).postData() ?? "null") as {
    allyFormations: readonly unknown[];
    enemyFormations: readonly unknown[];
  };
  expect(payload.allyFormations).toHaveLength(2);
  expect(payload.enemyFormations).toHaveLength(2);

  await expect(page.getByText("総力戦が完了しました。")).toBeVisible();

  // 結果ヘッダー: 勝敗・終了理由・撃破された編成数（分母は送信した編成数）。
  await expect(page.getByText("ALLY WIN / 味方勝利")).toBeVisible();
  await expect(page.getByText("敵の全編成を撃破")).toBeVisible();
  await expect(page.getByLabel("味方 撃破された編成")).toHaveText("味方 0 / 2");
  await expect(page.getByLabel("敵 撃破された編成")).toHaveText("敵 2 / 2");

  // 戦闘履歴: `result.stages`を発生順に1行ずつ。
  const history = page.getByRole("table", { name: "戦闘履歴" });
  await expect(history.getByRole("row")).toHaveCount(3);
  await expect(history.getByRole("row").nth(1)).toContainText("味方 編成1 vs 敵 編成1");
  await expect(history.getByRole("row").nth(1)).toContainText("1〜2");
  await expect(history.getByRole("row").nth(2)).toContainText("味方 編成1 vs 敵 編成2");
  await expect(history.getByRole("row").nth(2)).toContainText("敵の編成を撃破");

  // ユニット別表: 途中から出撃した敵の編成2も`unitRoster`から名前で出る。
  await expect(page.getByText("未出撃").first()).toBeVisible();
});

// UI-E2E-021: UI-AC-060。
test("switches, adds and removes formation tabs, and keeps the formations and result across modes and reloads", async ({
  page,
}) => {
  await page.goto("./");
  await openTotalWarMode(page);
  await fillTotalWarFormations(page);

  const allyPanel = page.locator("[data-formation-side='ally']");
  const allyTabs = page.getByRole("tablist", { name: "味方の編成" });
  const ally = page.getByRole("region", { name: /ALLY FORMATION/ });

  // 編成を追加すると空の編成3が表示され、上限の3編成で追加できなくなる。
  await allyPanel.getByRole("button", { name: "編成を追加" }).click();
  await expect(allyTabs.getByRole("tab")).toHaveCount(3);
  await expect(allyTabs.getByRole("tab", { name: /編成3/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(ally.getByRole("button", { name: "前衛1にユニットを追加" })).toBeVisible();
  await expect(allyPanel.getByRole("button", { name: "編成を追加" })).toHaveCount(0);

  // 表示中の編成3を削除すると、残った編成の中身はそのまま。
  await allyPanel.getByRole("button", { name: "この編成を削除" }).click();
  await expect(allyTabs.getByRole("tab")).toHaveCount(2);
  await allyTabs.getByRole("tab", { name: /編成1/ }).click();
  await expect(ally.getByRole("button", { name: /前衛1: アライアルファを変更/ })).toBeVisible();

  await page.getByRole("button", { name: "総力戦を開始" }).click();
  await expect(page.getByText("総力戦が完了しました。")).toBeVisible();

  // 他モードへ切り替えて戻っても、編成と直近の結果が残る。
  await page.getByRole("tab", { name: "通常戦闘" }).click();
  await expect(page.getByText("総力戦が完了しました。")).toHaveCount(0);
  await page.getByRole("tab", { name: "総力戦" }).click();
  await expect(page.getByText("総力戦が完了しました。")).toBeVisible();
  await expect(page.getByRole("table", { name: "戦闘履歴" })).toBeVisible();
  await expect(allyTabs.getByRole("tab")).toHaveCount(2);

  // リロード後は編成が復元される（結果は保存しない）。
  await page.reload();
  await openTotalWarMode(page);
  await expect(allyTabs.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tablist", { name: "敵の編成" }).getByRole("tab")).toHaveCount(2);
  await allyTabs.getByRole("tab", { name: /編成2/ }).click();
  await expect(ally.getByRole("button", { name: /前衛1: アライアルファを変更/ })).toBeVisible();
});
