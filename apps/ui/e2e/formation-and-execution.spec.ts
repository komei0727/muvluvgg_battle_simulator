import { expect, test } from "@playwright/test";
import { battleSuccessFixture } from "./fixtures/battle-success.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { fillMinimalFormation } from "./support/formation.js";
import { mockCatalog, mockSimulationSequence } from "./support/mock-api.js";

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

// UI-E2E-001: page load → 味方unit選択 → 敵unit選択 → turn設定 → submit →
// summary表示。UI-TEST-003 (unknown event fixture) is folded into the same
// success fixture so this single flow also proves the generic event
// fallback renders instead of crashing the page (UI-AC-011).
test("runs a minimal battle from formation to summary, tolerating an unknown event type", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleSuccessFixture }]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();

  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();
  await expect(page.getByText("ALLY UNIT SUMMARY")).toBeVisible();
  await expect(page.getByText("ENEMY UNIT SUMMARY")).toBeVisible();
  await expect(page.getByText("Battle ID: battle-e2e-001")).toBeVisible();

  // The unknown MYSTERIOUS_FUTURE_EVENT type must still render as a generic
  // row (its own type string as the title) rather than being dropped or
  // crashing the page.
  await expect(page.getByText("MYSTERIOUS_FUTURE_EVENT")).toBeVisible();
});

// UI-E2E-002: memory dialogに未対応itemと理由が表示される。
test("shows the unavailable-capability reason for a locked memory instead of hiding it", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  await page.getByRole("button", { name: "メモリー1を追加" }).first().click();

  const lockedItemButton = page.getByRole("button", { name: "封印された記憶を選択" });
  await expect(lockedItemButton).toBeDisabled();
  await expect(page.getByText(/CAP_M5_MEMORY_EFFECT/)).toBeVisible();
});

// UI-E2E-005: events → transitions → JSONを切り替え、JSONをcopyする。
test("switches between the event, transition, and JSON tabs and copies the JSON", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockSimulationSequence(page, [{ status: 200, body: battleSuccessFixture }]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  const tabs = page.getByRole("tablist", { name: "戦闘詳細" });
  await expect(tabs.getByRole("tab", { name: "時系列イベント" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await tabs.getByRole("tab", { name: "状態遷移" }).click();
  await expect(page.getByRole("tabpanel", { name: "状態遷移" })).toBeVisible();
  await expect(page.getByText("bu-enemy-1")).toBeVisible();

  await tabs.getByRole("tab", { name: "レスポンスJSON" }).click();
  const jsonPanel = page.getByRole("tabpanel", { name: "レスポンスJSON" });
  await expect(jsonPanel).toBeVisible();
  await expect(jsonPanel.getByText('"battleId": "battle-e2e-001"')).toBeVisible();

  await jsonPanel.getByRole("button", { name: "コピー" }).click();
  await expect(jsonPanel.getByText("コピーしました")).toBeVisible();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain('"battleId": "battle-e2e-001"');
});
