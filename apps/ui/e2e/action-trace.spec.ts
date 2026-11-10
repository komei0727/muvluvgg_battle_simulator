import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { battleActionTraceFixture } from "./fixtures/battle-action-trace.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { exerciseSuccessFixture } from "./fixtures/exercise-success.js";
import { totalWarSuccessFixture } from "./fixtures/total-war-success.js";
import {
  fillMinimalFormation,
  fillTotalWarFormations,
  openBattleMode,
  openTotalWarMode,
  selectDetailedLogLevel,
} from "./support/formation.js";
import {
  mockCatalog,
  mockSimulationSequence,
  mockTacticalExercise,
  mockTotalWar,
} from "./support/mock-api.js";

// docs/ui-design/01_UI要求・画面設計.md §8.10 / 06_UIテスト戦略.md（UI-E2E-022・UI-E2E-023）。
// fixtureの区間は8つ（戦闘開始・ターン1開始・味方の行動・敵の行動・ターン1終了・
// ターン2開始・味方の行動・戦闘終了）。

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

async function openTraceOfNormalBattle(page: Page): Promise<Locator> {
  await mockSimulationSequence(page, [{ status: 200, body: battleActionTraceFixture }]);
  await page.goto("./");
  await openBattleMode(page);
  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await selectDetailedLogLevel(page);
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();
  await page.getByRole("tab", { name: "行動トレース" }).click();
  const trace = page.getByRole("region", { name: "行動トレース" });
  await expect(trace).toBeVisible();
  return trace;
}

// Presses real Tab keystrokes until `target` is focused (see keyboard.spec.ts).
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 80): Promise<void> {
  for (let attempt = 0; attempt <= maxPresses; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the target via Tab within ${maxPresses} presses.`);
}

// UI-E2E-022: UI-AC-066, UI-AC-067, UI-AC-069。
test("steps through the action trace with the buttons, the step unit and a step row", async ({
  page,
}) => {
  const trace = await openTraceOfNormalBattle(page);
  const position = trace.getByRole("status", { name: "現在位置" });
  const steps = trace.getByRole("list", { name: "処理の一覧" });

  await expect(position).toContainText("行動 1 / 8");
  await expect(trace.getByRole("button", { name: "1単位戻る" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await trace.getByRole("button", { name: "1単位進む" }).click();
  await trace.getByRole("button", { name: "1単位進む" }).click();
  await expect(position).toContainText("行動 3 / 8");
  await expect(steps).toContainText("HIT_CONFIRMED");
  await expect(steps.getByText("割り込み").first()).toBeVisible();
  await expect(trace.getByRole("group", { name: /^アライアルファ.*行動中/ })).toBeVisible();

  await trace.getByRole("button", { name: "5単位進む" }).click();
  await expect(position).toContainText("行動 8 / 8");
  await trace.getByRole("button", { name: "5単位戻る" }).click();
  await expect(position).toContainText("行動 3 / 8");

  await trace
    .getByRole("group", { name: "進む単位" })
    .getByRole("button", { name: "処理" })
    .click();
  await expect(position).toContainText(/処理 \d+ \/ \d+/);
  await steps.getByRole("button", { name: /HIT_CONFIRMED/ }).click();
  await expect(position).toContainText("処理 4 /");
  await expect(steps.locator("li[aria-current='step']")).toContainText("HIT_CONFIRMED");
  await trace.getByRole("button", { name: "1単位進む" }).click();
  await expect(position).toContainText("処理 5 /");
});

// UI-E2E-023: UI-AC-067、UI-NFR-001。
test("operates the action trace with the keyboard only, and fits a 390px viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trace = await openTraceOfNormalBattle(page);
  const position = trace.getByRole("status", { name: "現在位置" });

  const traceTab = page.getByRole("tab", { name: "行動トレース" });
  await traceTab.focus();
  await expect(traceTab).toHaveAttribute("aria-selected", "true");
  // tabにフォーカスがある間は←→をtablistが使う。領域の中へTabで入ってから操作する
  const play = trace.getByRole("button", { name: "再生" });
  await tabUntilFocused(page, play);

  await page.keyboard.press("ArrowRight");
  await expect(position).toContainText("行動 2 / 8");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(position).toContainText("行動 7 / 8");
  await page.keyboard.press("ArrowLeft");
  await expect(position).toContainText("行動 6 / 8");
  await page.keyboard.press("End");
  await expect(position).toContainText("行動 8 / 8");
  await page.keyboard.press("Home");
  await expect(position).toContainText("行動 1 / 8");

  // ボタンの上のSpaceはボタン自身の操作（再生）になる
  await page.keyboard.press("Space");
  await expect(trace.getByRole("button", { name: "停止" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(trace.getByRole("button", { name: "再生" })).toBeVisible();

  const hasNoPageHorizontalScroll = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth <= root.clientWidth + 1;
  });
  // 詳細タブが8つでも1行に収まらない分は折り返し、ページを横に広げない
  expect(hasNoPageHorizontalScroll).toBe(true);
  for (const side of ["敵の配置", "味方の配置"]) {
    const row = trace.getByRole("table", { name: side }).getByRole("row", { name: "前衛" });
    await expect(row.getByRole("cell")).toHaveCount(3);
  }
  await expect(trace.getByRole("button", { name: "1単位進む" })).toBeInViewport();
});

// UI-AC-066: 戦術演習・総力戦の詳細タブでも末尾に行動トレースが出る。
test("shows the action trace tab for the tactical exercise and total war details", async ({
  page,
}) => {
  await mockTacticalExercise(page, { status: 200, body: exerciseSuccessFixture });
  await mockTotalWar(page, { status: 200, body: totalWarSuccessFixture });
  await page.goto("./");

  await page.getByRole("tab", { name: "戦術演習" }).click();
  await page
    .getByRole("region", { name: /ALLY FORMATION/ })
    .getByRole("button", { name: "前衛1にユニットを追加" })
    .click();
  await page.getByRole("button", { name: "アライアルファを選択" }).click();
  await page
    .getByRole("region", { name: /ENEMY FORMATION/ })
    .getByRole("button", { name: "前衛1にユニットを追加" })
    .click();
  await page.getByRole("button", { name: "エクササイズアルファを選択" }).click();
  await page.getByRole("button", { name: "戦術演習を開始" }).click();
  await expect(page.getByText("戦術演習が完了しました。")).toBeVisible();
  const exerciseTabs = page.getByRole("tablist", { name: "戦闘詳細" }).getByRole("tab");
  await expect(exerciseTabs.last()).toHaveText("行動トレース");
  await exerciseTabs.last().click();
  await expect(page.getByRole("region", { name: "行動トレース" })).toBeVisible();

  await openTotalWarMode(page);
  await fillTotalWarFormations(page);
  await selectDetailedLogLevel(page);
  await page.getByRole("button", { name: "総力戦を開始" }).click();
  await expect(page.getByRole("table", { name: "戦闘履歴" })).toBeVisible();
  const totalWarTabs = page.getByRole("tablist", { name: "戦闘詳細" }).getByRole("tab");
  await expect(totalWarTabs.last()).toHaveText("行動トレース");
  await totalWarTabs.last().click();
  await expect(page.getByRole("region", { name: "行動トレース" })).toBeVisible();
});
