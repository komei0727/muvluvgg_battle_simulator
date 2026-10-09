import { expect, test } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { exerciseSuccessFixture } from "./fixtures/exercise-success.js";
import { mockCatalog, mockTacticalExercise, requireAccessKey } from "./support/mock-api.js";

// docs/ui-design/03_API・データ連携設計.md §2.4: アクセスキーを要求する配備では、
// 401からキー入力へ誘導し、入力後は全API呼び出しへ`Authorization`を付ける。
const ACCESS_KEY = "e2e-access-key-0123456789abcdef0123456789";

test("UI-E2E-018: asks for an access key on 401, then loads the Catalog and runs an exercise with the key, keeping it across reloads", async ({
  page,
}) => {
  const received: (string | null)[] = [];
  await mockCatalog(page, { status: 200, body: catalogFixture });
  await mockTacticalExercise(page, { status: 200, body: exerciseSuccessFixture });
  await requireAccessKey(page, ACCESS_KEY, received);

  await page.goto("./");

  const keyInput = page.getByLabel("アクセスキー");
  await expect(keyInput).toBeVisible();
  await expect(page.getByRole("button", { name: "再読込" })).toHaveCount(0);

  await keyInput.fill(ACCESS_KEY);
  await page.getByRole("button", { name: "保存して接続" }).click();
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
  await expect(keyInput).toHaveCount(0);

  const ally = page.getByRole("region", { name: /ALLY FORMATION/ });
  const enemy = page.getByRole("region", { name: /ENEMY FORMATION/ });
  await ally.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "アライアルファを選択" }).click();
  await enemy.getByRole("button", { name: "前衛1にユニットを追加" }).click();
  await page.getByRole("button", { name: "エクササイズアルファを選択" }).click();
  await page.getByRole("button", { name: "戦術演習を開始" }).click();
  await expect(page.getByText("戦術演習が完了しました。")).toBeVisible();

  // 最初のCatalog取得だけがキーなしで、入力後の要求（Catalog・プレビュー・演習）は
  // すべてキーを持つ。
  expect(received[0]).toBeNull();
  expect(received.slice(1).length).toBeGreaterThan(1);
  expect(received.slice(1).every((value) => value === `Bearer ${ACCESS_KEY}`)).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
  await expect(page.getByLabel("アクセスキー")).toHaveCount(0);
});

test("UI-E2E-019: a wrong access key is explained and can be corrected", async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
  await requireAccessKey(page, ACCESS_KEY, []);

  await page.goto("./");
  await page.getByLabel("アクセスキー").fill("wrong-key-0123456789abcdef0123456789");
  await page.getByRole("button", { name: "保存して接続" }).click();
  await expect(page.getByText(/アクセスキーが正しくないか/)).toBeVisible();

  await page.getByLabel("アクセスキー").fill(ACCESS_KEY);
  await page.getByRole("button", { name: "保存して接続" }).click();
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
});
