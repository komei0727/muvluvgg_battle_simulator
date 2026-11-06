import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/m4.5-catalog.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import type {
  BattleSimulationCatalogResponse,
  FormationRequest,
  TotalWarRequest,
  TotalWarResponse,
  TotalWarResultResponse,
} from "../../shared/api/api-contract.js";
import { selectTotalWarResultView, selectTotalWarRoster } from "./total-war-result-projector.js";

const catalog = catalogFixture as BattleSimulationCatalogResponse;
const response = totalWarSuccessFixture as TotalWarResponse;

const EMPTY_FORMATION: FormationRequest = { units: [], memoryDefinitionIds: [] };

function request(allyCount: number, enemyCount: number): TotalWarRequest {
  return {
    allyFormations: Array.from({ length: allyCount }, () => EMPTY_FORMATION),
    enemyFormations: Array.from({ length: enemyCount }, () => EMPTY_FORMATION),
    options: { logLevel: "DETAILED" },
  };
}

function withResult(overrides: Partial<TotalWarResultResponse>): TotalWarResponse {
  return { ...response, result: { ...response.result, ...overrides } };
}

describe("selectTotalWarRoster (UI-UT-TWR-015 / UI-API-050)", () => {
  it("lists every formation's units in unitRoster order, including undeployed ones", () => {
    const roster = selectTotalWarRoster(response, catalog);

    expect(roster).toEqual([
      {
        battleUnitId: "ally:1",
        unitDefinitionId: "UNIT_UI_FIXTURE_ALLY",
        side: "ALLY",
        displayName: "UI Fixture Ally",
        formationNumber: 1,
        reappearance: false,
        deployed: true,
      },
      {
        battleUnitId: "ally:2",
        unitDefinitionId: "UNIT_UI_FIXTURE_ALLY",
        side: "ALLY",
        displayName: "UI Fixture Ally",
        formationNumber: 2,
        reappearance: true,
        deployed: false,
      },
      {
        battleUnitId: "enemy:1",
        unitDefinitionId: "UNIT_UI_FIXTURE_ENEMY",
        side: "ENEMY",
        displayName: "UI Fixture Enemy",
        formationNumber: 1,
        reappearance: false,
        deployed: true,
      },
      {
        battleUnitId: "enemy:2",
        unitDefinitionId: "UNIT_UI_FIXTURE_ENEMY",
        side: "ENEMY",
        displayName: "UI Fixture Enemy",
        formationNumber: 2,
        reappearance: true,
        deployed: true,
      },
    ]);
  });

  it("falls back to the definition ID when the Catalog does not know the unit", () => {
    const roster = selectTotalWarRoster(response, { ...catalog, units: [] });

    expect(roster.map((entry) => entry.displayName)).toEqual([
      "UNIT_UI_FIXTURE_ALLY",
      "UNIT_UI_FIXTURE_ALLY",
      "UNIT_UI_FIXTURE_ENEMY",
      "UNIT_UI_FIXTURE_ENEMY",
    ]);
  });
});

describe("selectTotalWarResultView (UI-UT-TWR-016)", () => {
  it("resolves the header and the denominators of defeated formations from the request", () => {
    const view = selectTotalWarResultView(response, request(2, 3));

    expect(view.outcomeLabel).toBe("ALLY WIN / 味方勝利");
    expect(view.completionReasonLabel).toBe("敵の全編成を撃破");
    expect(view.completedTurn).toBe(2);
    expect(view.turnLimit).toBe(15);
    expect(view.defeatedFormations).toEqual({
      ally: { defeated: 0, total: 2 },
      enemy: { defeated: 2, total: 3 },
    });
    expect(view.battleId).toBe(response.battleId);
    expect(view.catalogRevision).toBe(response.catalogRevision);
  });

  it.each([
    ["ALLY_LOSE", "ALLY_DEFEATED", "ALLY LOSE / 味方敗北", "味方の全編成が撃破"],
    ["DRAW", "SIMULTANEOUS_DEFEAT", "DRAW / 引き分け", "最後の編成どうしが同時全滅（引き分け）"],
    ["DRAW", "TURN_LIMIT_REACHED", "DRAW / 引き分け", "15ターン経過（引き分け）"],
    ["FUTURE_OUTCOME", "FUTURE_REASON", "FUTURE_OUTCOME", "FUTURE_REASON"],
  ])(
    "labels %s / %s with the total war dictionary",
    (outcome, completionReason, outcomeLabel, reasonLabel) => {
      const view = selectTotalWarResultView(
        withResult({ outcome, completionReason }),
        request(2, 2),
      );

      expect(view.outcomeLabel).toBe(outcomeLabel);
      expect(view.completionReasonLabel).toBe(reasonLabel);
    },
  );

  it("builds one history row per stage in order", () => {
    const view = selectTotalWarResultView(response, request(2, 2));

    expect(view.stages).toEqual([
      {
        stageNumber: 1,
        matchup: "味方 編成1 vs 敵 編成1",
        turns: "1",
        resultLabel: "敵の編成を撃破",
      },
      {
        stageNumber: 2,
        matchup: "味方 編成1 vs 敵 編成2",
        turns: "2",
        resultLabel: "敵の編成を撃破",
      },
    ]);
  });

  it("labels the result column from defeatedSides, and empty as undecided", () => {
    const view = selectTotalWarResultView(
      withResult({
        stages: [
          {
            stageNumber: 1,
            allyFormationNumber: 1,
            enemyFormationNumber: 1,
            startTurn: 1,
            endTurn: 3,
            defeatedSides: ["ALLY"],
          },
          {
            stageNumber: 2,
            allyFormationNumber: 2,
            enemyFormationNumber: 1,
            startTurn: 4,
            endTurn: 6,
            defeatedSides: ["ALLY", "ENEMY"],
          },
          {
            stageNumber: 3,
            allyFormationNumber: 3,
            enemyFormationNumber: 2,
            startTurn: 7,
            endTurn: 15,
            defeatedSides: [],
          },
        ],
      }),
      request(3, 2),
    );

    expect(view.stages.map((stage) => [stage.turns, stage.resultLabel])).toEqual([
      ["1〜3", "味方の編成が撃破"],
      ["4〜6", "同時全滅"],
      ["7〜15", "決着せず終了"],
    ]);
  });
});
