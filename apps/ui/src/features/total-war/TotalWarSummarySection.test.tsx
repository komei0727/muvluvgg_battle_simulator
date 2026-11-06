import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/m4.5-catalog.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import type {
  BattleSimulationCatalogResponse,
  FormationRequest,
  TotalWarRequest,
  TotalWarResponse,
} from "../../shared/api/api-contract.js";
import { selectTotalWarRoster } from "./total-war-result-projector.js";
import { TotalWarSummarySection } from "./TotalWarSummarySection.js";

const catalog = catalogFixture as BattleSimulationCatalogResponse;
// 生成fixture（TW-010b）: 敵の編成2が途中から出撃し（再登場）、味方の編成2は再登場のまま未出撃。
const response = totalWarSuccessFixture as TotalWarResponse;

const EMPTY_FORMATION: FormationRequest = { units: [], memoryDefinitionIds: [] };
const request: TotalWarRequest = {
  allyFormations: [EMPTY_FORMATION, EMPTY_FORMATION],
  enemyFormations: [EMPTY_FORMATION, EMPTY_FORMATION],
  options: { logLevel: "DETAILED" },
};

/** 編成の見出し行を除いた、ユニットの行。 */
function unitRows(table: HTMLElement): HTMLElement[] {
  return within(table)
    .getAllByRole("row")
    .filter((row) => within(row).queryAllByRole("cell").length > 0);
}

function renderSection(served: TotalWarResponse = response) {
  return render(
    <TotalWarSummarySection
      response={served}
      request={request}
      roster={selectTotalWarRoster(served, catalog)}
      catalog={catalog}
      imageMap={{}}
    />,
  );
}

function unitTable(side: "ALLY" | "ENEMY"): HTMLElement {
  const heading = screen.getByText(`${side} UNIT SUMMARY`);
  const section = heading.closest("section");
  if (section === null) {
    throw new Error(`${side} table not found`);
  }
  return section;
}

describe("TotalWarSummarySection (UI-AC-061〜063 / UI-CMP-040)", () => {
  it("shows the outcome header with the turn out of 15 and the defeated formations per side", () => {
    renderSection();

    expect(screen.getByText("ALLY WIN / 味方勝利")).toBeInTheDocument();
    expect(screen.getByText("敵の全編成を撃破")).toBeInTheDocument();
    expect(screen.getByText("2 / 15")).toBeInTheDocument();
    expect(screen.getByLabelText("味方 撃破された編成")).toHaveTextContent("0 / 2");
    expect(screen.getByLabelText("敵 撃破された編成")).toHaveTextContent("2 / 2");
    expect(screen.getByText(response.battleId)).toBeInTheDocument();
    expect(screen.getByText(response.catalogRevision)).toBeInTheDocument();
  });

  it("labels a draw as such", () => {
    renderSection({
      ...response,
      result: { ...response.result, outcome: "DRAW", completionReason: "TURN_LIMIT_REACHED" },
    });

    expect(screen.getByText("DRAW / 引き分け")).toBeInTheDocument();
    expect(screen.getByText("15ターン経過（引き分け）")).toBeInTheDocument();
  });

  it("lists the battle history in order", () => {
    renderSection();

    const table = screen.getByRole("table", { name: "戦闘履歴" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["1", "味方 編成1 vs 敵 編成1", "1", "敵の編成を撃破"],
      ["2", "味方 編成1 vs 敵 編成2", "2", "敵の編成を撃破"],
    ]);
  });

  it("groups each side's units by formation, badges reappearances and marks undeployed units", () => {
    renderSection();

    const ally = unitTable("ALLY");
    expect(within(ally).getByText("編成1")).toBeInTheDocument();
    expect(within(ally).getByText("編成2")).toBeInTheDocument();
    const allyRows = unitRows(ally);
    expect(allyRows).toHaveLength(2);
    expect(allyRows[1]).toHaveTextContent("UI Fixture Ally");
    expect(allyRows[0]).toHaveTextContent("ACTIVE");
    expect(allyRows[0]).not.toHaveTextContent("再登場 −99%");
    expect(allyRows[1]).toHaveTextContent("再登場 −99%");
    expect(allyRows[1]).toHaveTextContent("未出撃");
    expect(allyRows[1]).not.toHaveTextContent("ACTIVE");

    // 2番目の編成から途中出撃したユニットも名前で出る（initialStateには居ない）。
    const enemy = unitTable("ENEMY");
    const enemyRows = unitRows(enemy);
    expect(enemyRows).toHaveLength(2);
    expect(enemyRows[1]).toHaveTextContent("UI Fixture Enemy");
    expect(enemyRows[1]).toHaveTextContent("再登場 −99%");
    expect(enemyRows[1]).toHaveTextContent("999");
    expect(enemyRows[1]).toHaveTextContent("DEFEATED");
  });
});
