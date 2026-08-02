import { expect, test } from "@playwright/test";
import { battleDamageBreakdownFixture } from "./fixtures/battle-damage-breakdown.js";
import { battleHealEffectsFixture } from "./fixtures/battle-heal-effects.js";
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

// UI-E2E-009 (M7-009, Issue #182): HEAL列がfixtureの実回復量と一致し、付与された
// 効果・状態異常がユニット状態と時系列イベントの両方から辿れる
// (07_UI実装・拡張計画.md §11完了条件)。
test("shows the actually applied healing and the granted effects/status of an M7 battle", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleHealEffectsFixture }]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  // 実回復量40(自己回復) + 10(回復リンクの転送先で実際に増えた分) = 50。
  // 要求量60でも破棄分を含む合計でもない。
  const allyRow = page.getByRole("row", { name: /アライアルファ/ });
  await expect(allyRow.getByRole("cell", { name: "50", exact: true })).toBeVisible();

  // 状態の付与はイベント要約から辿れる（時系列イベントは`category`を持たないため
  // 状態異常かどうかを判定せず種別だけを出す。PR #264レビュー[P1]）。
  await expect(page.getByText(/状態 STUN/)).toBeVisible();

  // finalStateの効果一覧はユニット状態タブに出る。
  const tabs = page.getByRole("tablist", { name: "戦闘詳細" });
  await tabs.getByRole("tab", { name: "ユニット状態" }).click();
  const actionStatePanel = page.getByRole("tabpanel", { name: "ユニット状態" });
  await expect(actionStatePanel.getByText(/ACT_ALLY_ATTACK_UP/)).toBeVisible();
  await expect(actionStatePanel.getByText(/STUN（STATUS_ABNORMALITY）/)).toBeVisible();
});

// UI-E2E-010 (DMG-010, Issue #191): calculated / shield absorbed / subUnit
// absorbed / HP damage を混同せず表示し、subUnit状態とcollection deltaを
// 汎用JSONではなく意味のある表示で辿れる (07_UI実装・拡張計画.md §12完了条件)。
test("separates calculated damage, shield/sub unit absorption and HP damage of an M8 battle", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleDamageBreakdownFixture }]);
  await page.goto("./");

  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  // DAMAGE列は実HPダメージ 160 + 40 = 200。計算ダメージ 250 + 40 でも、
  // 吸収された90を足した値でもない (01_UI要求・画面設計.md §7.2)。
  const allyRow = page.getByRole("row", { name: /アライアルファ/ });
  await expect(allyRow.getByRole("cell", { name: "200", exact: true })).toBeVisible();

  // 内訳はイベント要約側に出る。
  await expect(
    page.getByText(
      /計算ダメージ250（タイプありシールド吸収30、タイプなしシールド吸収10、サブユニット吸収50） → HPダメージ160/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/PHYSICALシールドがヒット1で30吸収しました/)).toBeVisible();
  await expect(
    page.getByText(/サブユニット「ACT_ENEMY_SUBUNIT」がヒット1で50吸収しました/),
  ).toBeVisible();
  // 継続ダメージはヒット単位のダメージと別種別として読める。
  await expect(page.getByText(/継続ダメージ BURN（EN）/)).toBeVisible();

  // finalStateのシールドプールとサブユニットはユニット状態タブに出る。
  const tabs = page.getByRole("tablist", { name: "戦闘詳細" });
  await tabs.getByRole("tab", { name: "ユニット状態" }).click();
  const actionStatePanel = page.getByRole("tabpanel", { name: "ユニット状態" });
  await expect(
    actionStatePanel.getByText(/シールド: 物理 0 \/ EN 25 \/ タイプなし 0/),
  ).toBeVisible();
  await expect(actionStatePanel.getByText(/ACT_ALLY_SUBUNIT: 耐久 60 \/ 60/)).toBeVisible();

  // 状態遷移のEntityCollectionDeltaは件数だけでなく、消えたインスタンスを名指しする。
  await tabs.getByRole("tab", { name: "状態遷移" }).click();
  const transitionPanel = page.getByRole("tabpanel", { name: "状態遷移" });
  await expect(
    transitionPanel.getByText(/- ACT_ENEMY_SUBUNIT（battle-e2e-003:effect:1）/),
  ).toBeVisible();
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
