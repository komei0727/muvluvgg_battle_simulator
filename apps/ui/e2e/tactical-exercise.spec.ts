import { expect, test } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { exerciseSuccessFixture } from "./fixtures/exercise-success.js";
import { TACTICAL_EXERCISE_URL } from "./support/constants.js";
import { mockCatalog, mockTacticalExercise } from "./support/mock-api.js";
import { openBattleMode } from "./support/formation.js";

// docs/ui-design/06_UIテスト戦略.md §6 「Mock API E2E」: 戦術演習モードの
// 縦切り（モード切替 → 演習編成 → 実行 → スコア・ブレイク履歴・演習イベント）。
test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
  await mockTacticalExercise(page, { status: 200, body: exerciseSuccessFixture });
});

test("runs a tactical exercise from the mode tab to the score summary and break timeline", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  await page.getByRole("tab", { name: "戦術演習" }).click();

  // UI-AC-019: 敵メモリー枠とターン上限入力を出さず、5ターン固定と明示する。
  await expect(page.getByLabel("ターン上限")).toHaveCount(0);
  await expect(page.getByText("5ターン固定").first()).toBeVisible();
  await expect(page.getByText("ENEMY MEMORY / 0-6")).toHaveCount(0);

  const ally = page.getByRole("region", { name: /ALLY FORMATION/ });
  const enemy = page.getByRole("region", { name: /ENEMY FORMATION/ });
  await ally.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "アライアルファを選択" }).click();
  await enemy.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "エクササイズアルファを選択" }).click();

  await page.getByRole("button", { name: "戦術演習を開始" }).click();
  await expect(page.getByText("戦術演習が完了しました。")).toBeVisible();

  // UI-AC-021: 総スコア・ブレイク回数・終了理由・ブレイク履歴。勝敗は出ない。
  await expect(page.getByText("TOTAL SCORE")).toBeVisible();
  await expect(page.getByText("4,200", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("ターン上限到達", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("OUTCOME")).toHaveCount(0);
  const breakTimeline = page.getByRole("region", { name: /BREAK TIMELINE/ });
  await expect(breakTimeline.getByRole("row")).toHaveCount(2);
  await expect(breakTimeline.getByText("2,100")).toBeVisible();

  // UI-AC-022: 演習イベントも未知イベントも詳細タイムラインへ残る。
  await expect(page.getByText("EXERCISE_SCORE_ACCUMULATED").first()).toBeVisible();
  await expect(page.getByText("UNIT_BROKEN").first()).toBeVisible();
  await expect(page.getByText("UNIT_REVIVED").first()).toBeVisible();
  await expect(page.getByText("MYSTERIOUS_FUTURE_EXERCISE_EVENT").first()).toBeVisible();
});

test("keeps each mode's formation and latest result when switching back and forth", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  await page.getByRole("tab", { name: "戦術演習" }).click();
  const ally = page.getByRole("region", { name: /ALLY FORMATION/ });
  await ally.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "アライアルファを選択" }).click();

  await page.getByRole("tab", { name: "通常戦闘" }).click();
  // 通常戦闘のdraftは演習の入力を引き継がない。
  await expect(
    page.getByRole("region", { name: /ALLY FORMATION/ }).getByRole("button", {
      name: "前衛1にユニットを追加",
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "戦術演習" }).click();
  await expect(
    page.getByRole("region", { name: /ALLY FORMATION/ }).getByRole("button", {
      name: /前衛1: アライアルファを変更/,
    }),
  ).toBeVisible();
});

// 空き枠の`＋`とラベルは1つのまとまりとして枠の中央に置く。枠の高さは`min-height`
// 由来で不定なため、`height: 100%`に頼ると置かれ方（grid配下か単独のblock配下か）で
// 中央寄せが崩れる。両モードで同じ見え方になることを実ブラウザで押さえる。
test("centers the empty unit slot's placeholder in both modes", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  const expectCentered = async (slot: ReturnType<typeof page.getByRole>) => {
    const outer = await slot.boundingBox();
    const inner = await slot.locator("span").first().boundingBox();
    expect(outer).not.toBeNull();
    expect(inner).not.toBeNull();
    const outerCenter = outer!.y + outer!.height / 2;
    const innerCenter = inner!.y + inner!.height / 2;
    expect(Math.abs(outerCenter - innerCenter)).toBeLessThanOrEqual(2);
  };

  await expectCentered(
    page
      .getByRole("region", { name: /ALLY FORMATION/ })
      .getByRole("button", { name: "前衛1にユニットを追加" }),
  );

  await page.getByRole("tab", { name: "戦術演習" }).click();
  await expectCentered(
    page
      .getByRole("region", { name: /ENEMY FORMATION/ })
      .getByRole("button", { name: "前衛1にユニットを追加" }),
  );
});

// UI-E2E-014: UI-AC-019。演習の敵も2×3の盤面から配置枠を選べ、選んだ座標が
// そのままリクエストへ載る。別の枠を選んでも2体目にはならず、1体が移る。
test("places the exercise enemy in the chosen cell and posts that position", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  await page.getByRole("tab", { name: "戦術演習" }).click();

  const ally = page.getByRole("region", { name: /ALLY FORMATION/ });
  const enemy = page.getByRole("region", { name: /ENEMY FORMATION/ });
  await ally.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "アライアルファを選択" }).click();
  await enemy.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "エクササイズアルファを選択" }).click();

  // 空いている別の枠で選び直すと、置いていた1体がその枠へ移る。
  await enemy.getByRole("button", { name: "後衛3にユニットを追加" }).click();
  await page.getByRole("button", { name: "エクササイズアルファを選択" }).click();
  await expect(
    enemy.getByRole("button", { name: "後衛3: エクササイズアルファを変更" }),
  ).toBeVisible();
  await expect(enemy.getByRole("button", { name: "前衛1にユニットを追加" })).toBeVisible();

  const exerciseRequest = page.waitForRequest(TACTICAL_EXERCISE_URL);
  await page.getByRole("button", { name: "戦術演習を開始" }).click();
  const payload: unknown = JSON.parse((await exerciseRequest).postData() ?? "null");

  expect(payload).toMatchObject({
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_EXERCISE_A", position: { column: 2, row: "REAR" } }],
    },
  });
});

// 演習の敵はスコアを競う相手として定義どおりの1体（R-TEX-01 #1）。学園レベルは
// 利用者自身の育成情報なので、敵陣営には出さない。
test("shows no enemy enhancement controls in the exercise mode", async ({ page }) => {
  await page.goto("./");
  await openBattleMode(page);
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
  await expect(page.getByText("ENEMY ENHANCEMENT / 学園レベル")).toBeVisible();

  await page.getByRole("tab", { name: "戦術演習" }).click();

  await expect(page.getByText("ENEMY ENHANCEMENT / 学園レベル")).toHaveCount(0);
  await expect(page.getByText("ALLY ENHANCEMENT / 学園レベル")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /強化/ })).toHaveCount(1);
});

// UI-E2E-013: R-TEX-11 #2 #3。演習の敵選択は演習専用ユニットだけを出し、開催中／
// 開催終了をバッジで示す。通常戦闘・演習味方の選択にはプレイアブルだけが出る。
test("separates the exercise enemy pool from the playable pool", async ({ page }) => {
  await page.goto("./");
  await openBattleMode(page);
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  // 通常戦闘: 両陣営とも演習専用ユニットを出さない。
  await page
    .getByRole("region", { name: /ENEMY FORMATION/ })
    .getByRole("button", { name: "前衛1にユニットを追加" })
    .click();
  await expect(page.getByRole("button", { name: "エネミーアルファを選択" })).toBeVisible();
  await expect(page.getByRole("button", { name: "エクササイズアルファを選択" })).toHaveCount(0);
  await page.getByRole("button", { name: "閉じる" }).click();

  await page.getByRole("tab", { name: "戦術演習" }).click();

  // 演習の味方: プレイアブルのみ。
  await page
    .getByRole("region", { name: /ALLY FORMATION/ })
    .getByRole("button", { name: "前衛1にユニットを追加" })
    .click();
  await expect(page.getByRole("button", { name: "アライアルファを選択" })).toBeVisible();
  await expect(page.getByRole("button", { name: "エクササイズアルファを選択" })).toHaveCount(0);
  await page.getByRole("button", { name: "アライアルファを選択" }).click();

  // 演習の敵: 演習専用ユニットのみ。開催終了も選べる。
  await page
    .getByRole("region", { name: /ENEMY FORMATION/ })
    .getByRole("button", { name: "前衛1にユニットを追加" })
    .click();
  await expect(page.getByRole("button", { name: "エクササイズアルファを選択" })).toBeVisible();
  await expect(page.getByRole("button", { name: "エクササイズブラボーを選択" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "アライアルファを選択" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "エネミーアルファを選択" })).toHaveCount(0);
  await expect(page.getByText("開催中")).toBeVisible();
  await expect(page.getByText("開催終了")).toBeVisible();

  await page.getByRole("button", { name: "エクササイズブラボーを選択" }).click();
  await expect(page.getByRole("button", { name: "戦術演習を開始" })).toBeEnabled();
});
