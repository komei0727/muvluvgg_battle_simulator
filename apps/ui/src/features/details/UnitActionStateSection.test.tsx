import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnitActionStateSection } from "./UnitActionStateSection.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../../shared/api/api-contract.js";

function catalogWith(
  units: BattleSimulationCatalogResponse["units"],
): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision: "rev-1", units, memories: [] };
}

function responseWith(overrides: {
  units: readonly Record<string, unknown>[];
  events?: BattleSimulationResponse["events"];
}): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId: "battle-1",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: { units: overrides.units as never },
    finalState: { units: overrides.units as never },
    unitSummaries: [],
    events: overrides.events ?? [],
    stateTransitions: [],
  };
}

describe("UnitActionStateSection", () => {
  it("shows AP/PP/EX for each battleUnitId in the ally and enemy groups (UI-UT-ACT-010)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          resources: {
            ap: { current: 2, maximum: 3 },
            pp: { current: 5, maximum: 8 },
            extraGauge: { current: 40, maximum: 100 },
          },
        },
        {
          battleUnitId: "enemy:1",
          unitDefinitionId: "UNIT_B",
          side: "ENEMY",
          resources: {
            ap: { current: 1, maximum: 3 },
            pp: { current: 0, maximum: 8 },
            extraGauge: { current: 0, maximum: 100 },
          },
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("AP 2 / 3")).toBeInTheDocument();
    expect(screen.getByText("PP 5 / 8")).toBeInTheDocument();
    expect(screen.getByText("EX 40 / 100")).toBeInTheDocument();
    expect(screen.getByText("AP 1 / 3")).toBeInTheDocument();
    expect(screen.getByText("PP 0 / 8")).toBeInTheDocument();
    expect(screen.getByText("EX 0 / 100")).toBeInTheDocument();
  });

  it("resolves displayName from the catalog", () => {
    const catalog = catalogWith([
      {
        unitDefinitionId: "UNIT_A",
        displayName: "エー",
        characterName: "エー",
        attribute: "CUTE",
        unitType: "HUMANOID",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
      },
    ]);
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} catalog={catalog} logLevel="DETAILED" />);

    expect(screen.getByText("エー")).toBeInTheDocument();
  });

  it("shows a cooldown derived from COOLDOWN_STARTED with the skill id and remaining count", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
      events: [
        {
          sequence: 1,
          type: "COOLDOWN_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: [],
          details: {
            actorUnitId: "ally:1",
            skillDefinitionId: "SKILL_1",
            unit: "TURN",
            initialRemaining: 3,
          },
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/SKILL_1/)).toBeInTheDocument();
    expect(screen.getByText(/残り3/)).toBeInTheDocument();
  });

  it("shows a charging skill id when CHARGE_STARTED has no matching CHARGE_RELEASED", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
      events: [
        {
          sequence: 1,
          type: "CHARGE_STARTED",
          category: "FACT",
          turnNumber: 1,
          cycleNumber: 1,
          rootSequence: 1,
          sourceUnitId: "ally:1",
          targetUnitIds: [],
          details: {
            actorUnitId: "ally:1",
            skillDefinitionId: "SKILL_2",
            startedActionId: "action-1",
          },
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/チャージ中/)).toBeInTheDocument();
    expect(screen.getByText(/SKILL_2/)).toBeInTheDocument();
  });

  it("shows a dash for AP/PP/EX and no cooldown row for an M4 fixture unit without resources/events (back-compat)", () => {
    const response = responseWith({
      units: [{ battleUnitId: "bu-ally-1", unitDefinitionId: "UNIT_ALLY_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("AP -")).toBeInTheDocument();
    expect(screen.getByText("PP -")).toBeInTheDocument();
    expect(screen.getByText("EX -")).toBeInTheDocument();
    expect(screen.getByText("クールタイムなし")).toBeInTheDocument();
  });

  // SUMMARYレベルではCOOLDOWN_*/CHARGE_*イベントが公開ログから
  // 除外されるため、実際は残っていても「クールタイムなし」と断定してはいけない。
  it("shows an unknown state instead of asserting no cooldown when logLevel is SUMMARY", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="SUMMARY" />);

    expect(screen.queryByText("クールタイムなし")).not.toBeInTheDocument();
    expect(screen.getByText(/SUMMARYログ/)).toBeInTheDocument();
  });

  it("lists finalState effects with their kind, category and remaining duration (UI-CT-017)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_ATTACK_UP",
              category: "BUFF",
              effectKindKey: "ACT_ATTACK_UP",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0.1 },
              duration: { unit: "TURN", remaining: 2 },
              appliedTurnNumber: 1,
            },
          ],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/ACT_ATTACK_UP/)).toBeInTheDocument();
    expect(screen.getByText(/BUFF/)).toBeInTheDocument();
    expect(screen.getByText(/TURN 2/)).toBeInTheDocument();
  });

  // Issue #519: `effectKindKey`はCatalog宣言由来の同種グループ鍵になり、複数の
  // 定義が共有し得る。効果そのものの名前は`effectDefinitionId`で表す。
  it("names an effect by its definition id, not by the kindKey group it belongs to (UI-CT-074)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
              category: "BUFF",
              effectKindKey: "KIND_ELENA_MOODMAKER_EX_ATK_UP",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0.35 },
              duration: { unit: "TURN", remaining: 2 },
              appliedTurnNumber: 1,
            },
          ],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH/)).toBeInTheDocument();
    expect(screen.queryByText(/KIND_ELENA_MOODMAKER_EX_ATK_UP/)).not.toBeInTheDocument();
  });

  it("names a status abnormality by its statusKind and marks a superseded duplicate as inactive (UI-CT-018)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_STUN_1",
              category: "STATUS_ABNORMALITY",
              effectKindKey: "ACT_STUN_1",
              statusKind: "STUN",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0 },
              duration: { unit: "ACTION", remaining: 1 },
              appliedTurnNumber: 1,
            },
            {
              effectInstanceId: "battle-1:effect:2",
              effectDefinitionId: "ACT_ATTACK_UP",
              category: "BUFF",
              effectKindKey: "ACT_ATTACK_UP",
              stackMode: "NON_STACKING",
              isEffective: false,
              value: { magnitude: 0.05 },
              appliedTurnNumber: 1,
            },
          ],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/STUN/)).toBeInTheDocument();
    expect(screen.getByText(/次点/)).toBeInTheDocument();
  });

  it("labels an advantageous APPLY_STATUS by the API's BUFF category rather than as a status abnormality (UI-CT-021)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [
            {
              effectInstanceId: "battle-1:effect:1",
              effectDefinitionId: "ACT_STEALTH_1",
              category: "BUFF",
              effectKindKey: "ACT_STEALTH_1",
              statusKind: "STEALTH",
              stackMode: "NON_STACKING",
              isEffective: true,
              value: { magnitude: 0 },
              appliedTurnNumber: 1,
            },
          ],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/STEALTH（BUFF）/)).toBeInTheDocument();
    expect(screen.queryByText(/STATUS_ABNORMALITY/)).not.toBeInTheDocument();
  });

  it("says effects are unknown, not absent, for a fixture whose finalState has no effects array (UI-CT-019)", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.queryByText("効果なし")).not.toBeInTheDocument();
    expect(screen.getByText(/効果.*不明/)).toBeInTheDocument();
  });

  it("says there is no effect when finalState reports a truthfully empty effects array (UI-CT-020)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("効果なし")).toBeInTheDocument();
  });

  it("shows the known cooldown/charge state as usual when logLevel is DETAILED", () => {
    const response = responseWith({
      units: [{ battleUnitId: "ally:1", unitDefinitionId: "UNIT_A", side: "ALLY" }],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("クールタイムなし")).toBeInTheDocument();
    expect(screen.queryByText(/SUMMARYログ/)).not.toBeInTheDocument();
  });

  // DMG-010（Issue #191）: 「shield吸収、HP damage内訳」
  // 「sub unit」をUnit詳細へ追加する（サマリ列は増やさない）。
  it("shows the shield pools and sub unit instances of finalState (UI-CT-022)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
          shields: { physical: 120, energy: 0, untyped: 30 },
          subUnits: [
            {
              subUnitInstanceId: "battle-1:effect:9",
              subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
              durability: { current: 20, maximum: 50 },
              appliedTurnNumber: 1,
            },
          ],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/シールド.*物理 120.*EN 0.*タイプなし 30/)).toBeInTheDocument();
    expect(screen.getByText(/ACT_SUBUNIT_DRONE.*20 \/ 50/)).toBeInTheDocument();
  });

  it("says there is no shield or sub unit when finalState truthfully reports zero and an empty list (UI-CT-023)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
          shields: { physical: 0, energy: 0, untyped: 0 },
          subUnits: [],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText("シールドなし")).toBeInTheDocument();
    expect(screen.getByText("サブユニットなし")).toBeInTheDocument();
  });

  // DMG-004後・DMG-005前のように片方だけを持つレスポンスでは、
  // 欠落側が何も描画されず「不明」とも読めなくなっていた。個別に不明表示する。
  it("says only the missing side is unknown when a response carries shields but not subUnits (UI-CT-025)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
          shields: { physical: 40, energy: 0, untyped: 0 },
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/シールド.*物理 40/)).toBeInTheDocument();
    expect(screen.getByText(/サブユニット.*不明/)).toBeInTheDocument();
    expect(screen.queryByText("サブユニットなし")).not.toBeInTheDocument();
    expect(screen.queryByText(/シールド.*不明/)).not.toBeInTheDocument();
  });

  it("says only the missing side is unknown when a response carries subUnits but not shields (UI-CT-026)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
          subUnits: [],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.getByText(/シールド.*不明/)).toBeInTheDocument();
    expect(screen.getByText("サブユニットなし")).toBeInTheDocument();
    expect(screen.queryByText("シールドなし")).not.toBeInTheDocument();
  });

  it("says shields and sub units are unknown, not absent, for a fixture recorded before the M8 contract (UI-CT-024)", () => {
    const response = responseWith({
      units: [
        {
          battleUnitId: "ally:1",
          unitDefinitionId: "UNIT_A",
          side: "ALLY",
          cooldowns: [],
          effects: [],
        },
      ],
    });

    render(<UnitActionStateSection response={response} logLevel="DETAILED" />);

    expect(screen.queryByText("シールドなし")).not.toBeInTheDocument();
    expect(screen.queryByText("サブユニットなし")).not.toBeInTheDocument();
    expect(screen.getByText(/シールド.*不明/)).toBeInTheDocument();
    expect(screen.getByText(/サブユニット.*不明/)).toBeInTheDocument();
  });
});
