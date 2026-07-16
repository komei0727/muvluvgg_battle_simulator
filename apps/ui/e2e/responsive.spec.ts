import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { mockCatalog } from "./support/mock-api.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

async function hasNoPageHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    // 1px tolerance for subpixel layout rounding.
    return root.scrollWidth <= root.clientWidth + 1;
  });
}

// docs/ui-design/05_非機能・アクセシビリティ設計.md §4 「>= 1041px」: 味方、
// VS、敵を横3列に配置する。
test("desktop (1440x900) places ally and enemy formations side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("./");

  const allyBox = await page.getByRole("heading", { name: /ALLY FORMATION/ }).boundingBox();
  const enemyBox = await page.getByRole("heading", { name: /ENEMY FORMATION/ }).boundingBox();
  expect(allyBox).not.toBeNull();
  expect(enemyBox).not.toBeNull();
  // Side by side: ally sits to the left of enemy, roughly on the same row.
  expect(allyBox!.x).toBeLessThan(enemyBox!.x);
  expect(Math.abs(allyBox!.y - enemyBox!.y)).toBeLessThan(10);
  expect(await hasNoPageHorizontalScroll(page)).toBe(true);
});

// docs/ui-design/05_非機能・アクセシビリティ設計.md §4 「761px–1040px」: 味方、
// 敵を縦に配置する。各陣営内のFRONT 3枠・REAR 3枠は横3列のまま保つ。
for (const viewport of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test(`tablet (${viewport.width}x${viewport.height}) stacks ally above enemy while keeping 3 columns per row`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("./");

    const allyBox = await page.getByRole("heading", { name: /ALLY FORMATION/ }).boundingBox();
    const enemyBox = await page.getByRole("heading", { name: /ENEMY FORMATION/ }).boundingBox();
    expect(allyBox).not.toBeNull();
    expect(enemyBox).not.toBeNull();
    expect(allyBox!.y).toBeLessThan(enemyBox!.y);

    const frontSlots = await page.getByRole("button", { name: /前衛\dにユニットを追加/ }).all();
    const boxes = await Promise.all(frontSlots.slice(0, 3).map((slot) => slot.boundingBox()));
    const ys = boxes.map((box) => box!.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
    expect(await hasNoPageHorizontalScroll(page)).toBe(true);
  });
}

// docs/ui-design/05_非機能・アクセシビリティ設計.md §4 「<= 760px」/UI-NFR-002,
// UI-NFR-003, UI-E2E-007: 390px幅で編成3枠の意味と主要操作が維持される。
for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`mobile (${viewport.width}x${viewport.height}) has no page-level horizontal scroll and keeps the FRONT/REAR 3-column meaning`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("./");

    await expect(page.getByText("FRONT / 前衛").first()).toBeVisible();
    await expect(page.getByText("REAR / 後衛").first()).toBeVisible();
    expect(await page.getByText("FRONT / 前衛").count()).toBe(2);

    const frontSlots = await page.getByRole("button", { name: /前衛\dにユニットを追加/ }).all();
    const boxes = await Promise.all(frontSlots.slice(0, 3).map((slot) => slot.boundingBox()));
    const ys = boxes.map((box) => box!.y);
    const xs = boxes.map((box) => box!.x);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
    expect(new Set(xs).size).toBe(3);

    expect(await hasNoPageHorizontalScroll(page)).toBe(true);
  });
}
