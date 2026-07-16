import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { battleSuccessFixture } from "./fixtures/battle-success.js";
import { catalogFixture } from "./fixtures/catalog.js";
import { fillMinimalFormation } from "./support/formation.js";
import { mockCatalog, mockSimulationSequence } from "./support/mock-api.js";

const SERIOUS_IMPACTS = new Set(["critical", "serious"]);

// docs/ui-design/06_UIテスト戦略.md §8 自動: "axe等による重大/深刻violation
// 0件" — moderate/minor findings are left to the manual accessibility pass
// this doc also requires, so only critical/serious findings gate CI here.
function assertNoSeriousViolations(violations: readonly { impact?: string | null }[]): void {
  const serious = violations.filter(
    (violation) => violation.impact !== undefined && SERIOUS_IMPACTS.has(violation.impact ?? ""),
  );
  expect(serious).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
});

test("the idle formation screen has no critical/serious automated accessibility violations", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  assertNoSeriousViolations(results.violations);
});

test("an open unit selection dialog has no critical/serious automated accessibility violations", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "前衛1にユニットを追加" }).first().click();
  await expect(page.getByRole("dialog", { name: "ユニットを選択" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  assertNoSeriousViolations(results.violations);
});

test("the battle summary and details screen has no critical/serious automated accessibility violations", async ({
  page,
}) => {
  await mockSimulationSequence(page, [{ status: 200, body: battleSuccessFixture }]);
  await page.goto("./");
  await fillMinimalFormation(page, "アライアルファ", "エネミーアルファ");
  await page.getByRole("button", { name: "戦闘を開始" }).click();
  await expect(page.getByText("戦闘が完了しました。")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  assertNoSeriousViolations(results.violations);
});
