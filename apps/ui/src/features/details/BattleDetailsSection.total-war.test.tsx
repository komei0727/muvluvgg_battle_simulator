import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/m4.5-catalog.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import { selectTotalWarRoster } from "../total-war/total-war-result-projector.js";
import type {
  BattleSimulationCatalogResponse,
  TotalWarResponse,
} from "../../shared/api/api-contract.js";
import { BattleDetailsSection } from "./BattleDetailsSection.js";

const catalog = catalogFixture as BattleSimulationCatalogResponse;
// 生成fixture（TW-010b）: 敵の編成2（enemy:2）が2ターン目に途中から出撃し、
// 味方の編成2（ally:2）は控えのまま終わる。
const response = totalWarSuccessFixture as TotalWarResponse;

function renderDetails() {
  return render(
    <BattleDetailsSection
      response={response}
      catalog={catalog}
      logLevel="DETAILED"
      roster={selectTotalWarRoster(response, catalog)}
    />,
  );
}

describe("BattleDetailsSection with a total war Roster (UI-AC-064 / UI-CMP-040)", () => {
  it("summarizes formation events and resolves units that joined mid-battle by name", () => {
    renderDetails();

    expect(screen.getByText("敵の編成2が出撃: UI Fixture Enemy")).toBeInTheDocument();
    expect(screen.getByText("敵の編成1が全滅（控え残り1）")).toBeInTheDocument();
    expect(screen.queryByText(/enemy:2/)).not.toBeInTheDocument();
  });

  it("lists addedUnits as one deploy line per unit in the state transitions", async () => {
    const user = userEvent.setup();
    renderDetails();

    await user.click(screen.getByRole("tab", { name: "状態遷移" }));

    expect(screen.getByText("addedUnits[0]: + UI Fixture Enemy 出撃")).toBeInTheDocument();
    expect(screen.getAllByText(/formations\.enemy\.activeFormationNumber/).length).toBeGreaterThan(
      0,
    );
  });

  it("shows every formation's units in the unit state tab, marking undeployed ones", async () => {
    const user = userEvent.setup();
    renderDetails();

    await user.click(screen.getByRole("tab", { name: "ユニット状態" }));

    const panel = screen.getByRole("tabpanel");
    const allyItems = within(panel)
      .getAllByText("UI Fixture Ally")
      .map((name) => name.closest("li"));
    expect(allyItems).toHaveLength(2);
    expect(allyItems[1]).toHaveTextContent("未出撃");
    expect(allyItems[1]).not.toHaveTextContent("不明");
    expect(within(panel).getAllByText("編成2")).toHaveLength(2);
    // 途中から出撃した敵は finalState から読める。
    const enemyItems = within(panel)
      .getAllByText("UI Fixture Enemy")
      .map((name) => name.closest("li"));
    expect(enemyItems).toHaveLength(2);
    expect(enemyItems[1]).not.toHaveTextContent("未出撃");
  });

  it("puts the action trace tab last for a total war and shows a mid-battle deployment on the final board by name", async () => {
    const user = userEvent.setup();
    renderDetails();

    expect(screen.getAllByRole("tab").at(-1)).toHaveTextContent("行動トレース");
    await user.click(screen.getByRole("tab", { name: "行動トレース" }));
    const panel = screen.getByRole("tabpanel", { name: "行動トレース" });
    await user.click(within(panel).getByRole("button", { name: "末尾へ" }));

    const enemyBoard = within(panel).getByRole("region", { name: "敵の盤面" });
    expect(
      within(enemyBoard).getByRole("group", { name: /^UI Fixture Enemy/ }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/enemy:2/)).not.toBeInTheDocument();
  });
});
