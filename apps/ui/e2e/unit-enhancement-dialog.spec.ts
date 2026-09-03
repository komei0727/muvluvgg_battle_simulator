import { expect, test } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { mockCatalog } from "./support/mock-api.js";
import { fillMinimalFormation, openBattleMode } from "./support/formation.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

// #663: #658で追加した「モジュール補正の上書き」セクション（6入力）により、
// ユニット強化ダイアログの合計高さがDialog（components/Dialog.module.css）の
// max-heightを超えるようになった。`.panel`は`overflow: hidden`のため、
// はみ出した内容（ギア9枠など）はマウスホイールでスクロールできずクリップされ、
// 短いウィンドウで入力不能になっていた。
//
// jsdomの既存コンポーネントテストは実レイアウトを計算しないため、この種の
// クリップ・スクロール不能は検出できない（Dialog.test.tsx・
// UnitEnhancementDialog.test.tsxはいずれも通過したまま#663が発生した）。
//
// `scrollIntoViewIfNeeded`（script経由のscrollIntoView）は`overflow: hidden`な
// 要素も動かせてしまい、ユーザーが実際にホイールで操作できるかを区別できない
// ため使わない——ここでは`page.mouse.wheel`で実際のホイール入力を送り、
// `overflow: hidden`のままなら動かない・`overflow-y: auto`なら動くという
// 差を固定する。
test("UI-E2E-017: mouse-wheel scrolling the enhancement dialog body reaches the last gear slot on a short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 480 });
  await page.goto("./");
  await openBattleMode(page);
  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");

  await page
    .getByRole("checkbox", { name: "強化を有効にする" })
    .first()
    .click();
  await page.getByRole("button", { name: "前衛1: アライアルファの強化を編集" }).click();

  const dialog = page.getByRole("dialog", { name: "アライアルファの強化" });
  await expect(dialog).toBeVisible();
  const header = page.getByRole("heading", { name: "アライアルファの強化" });

  const lastGearStat = page.getByLabel("ギア9 の対象ステータス");
  const panelBoxBefore = (await dialog.boundingBox())!;
  const gearBoxBefore = (await lastGearStat.boundingBox())!;
  const headerBoxBefore = (await header.boundingBox())!;

  // Sanity check: at this viewport height the last gear slot genuinely
  // overflows the dialog's visible frame before any scrolling. Without this,
  // the assertion below (after the wheel scroll) would pass vacuously even
  // if the dialog never overflowed in the first place.
  expect(gearBoxBefore.y + gearBoxBefore.height).toBeGreaterThan(
    panelBoxBefore.y + panelBoxBefore.height,
  );

  // Hover over the dialog panel and send real wheel input, as a user would —
  // this is what `overflow: hidden` blocks and `overflow-y: auto` allows.
  await page.mouse.move(panelBoxBefore.x + panelBoxBefore.width / 2, panelBoxBefore.y + 200);
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.wheel(0, 200);
  }

  // The overlay panel itself does not move (`position: fixed`); only its
  // scrollable body does. If the body were not wheel-scrollable (the #663
  // bug), the wheel input has no effect and the slot stays clipped outside
  // the panel's visible frame — this assertion would fail.
  const panelBoxAfter = (await dialog.boundingBox())!;
  const gearBoxAfter = (await lastGearStat.boundingBox())!;
  expect(gearBoxAfter.y).toBeGreaterThanOrEqual(panelBoxAfter.y);
  expect(gearBoxAfter.y + gearBoxAfter.height).toBeLessThanOrEqual(
    panelBoxAfter.y + panelBoxAfter.height + 1,
  );

  // The header (title, close button) stays visible throughout — only the
  // body scrolls, never the whole panel. `toBeVisible()` alone would not
  // catch a regression where `.panel` itself became the scroll container
  // (e.g. reverting to a single scrollable panel instead of a fixed header
  // + scrollable body): the header would still satisfy Playwright's
  // "visible" definition (non-zero box, not display:none/visibility:hidden)
  // even while scrolled outside the panel's clipped frame or off-viewport.
  // Assert its position explicitly instead: unmoved by the wheel input, and
  // still inside the panel's bounds.
  const headerBoxAfter = (await header.boundingBox())!;
  expect(headerBoxAfter.y).toBeCloseTo(headerBoxBefore.y, 0);
  expect(headerBoxAfter.y).toBeGreaterThanOrEqual(panelBoxAfter.y);
  expect(headerBoxAfter.y + headerBoxAfter.height).toBeLessThanOrEqual(
    panelBoxAfter.y + panelBoxAfter.height,
  );
});
