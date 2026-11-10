import { describe, expect, it } from "vitest";
import type { RosterEntry } from "../../entities/roster.js";
import type {
  BattleStateResponse,
  BattleUnitStateResponse,
} from "../../shared/api/api-contract.js";
import { buildRosterIndex } from "../details/event-presentation.js";
import { projectTraceChanges } from "./trace-change-projector.js";

const ROSTER_ENTRIES: readonly RosterEntry[] = [
  {
    battleUnitId: "ally:1",
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    displayName: "【先駆】味方A",
  },
  { battleUnitId: "ally:2", unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "味方B" },
  { battleUnitId: "enemy:1", unitDefinitionId: "UNIT_C", side: "ENEMY", displayName: "敵C" },
];
const ROSTER = buildRosterIndex(ROSTER_ENTRIES);

function unit(
  battleUnitId: string,
  side: string,
  overrides: Readonly<Record<string, unknown>> = {},
): BattleUnitStateResponse {
  return {
    battleUnitId,
    unitDefinitionId: "UNIT",
    side,
    combatStatus: "ACTIVE",
    hp: { current: 100, maximum: 100 },
    resources: {
      ap: { current: 3, maximum: 3 },
      pp: { current: 2, maximum: 3 },
      extraGauge: { current: 10, maximum: 100 },
    },
    shields: { physical: 0, energy: 0, untyped: 0 },
    effects: [],
    markers: [],
    ...overrides,
  };
}

function effect(id: string, definition: string, remaining: number) {
  return {
    effectInstanceId: id,
    effectDefinitionId: definition,
    category: "BUFF",
    duration: { unit: "TURN", remaining },
  };
}

function state(...units: readonly BattleUnitStateResponse[]): BattleStateResponse {
  return { units };
}

describe("projectTraceChanges", () => {
  it("UI-UT-ATR-039: 範囲の前後で変化したユニットだけを、HP・リソース・シールド・効果・撃破の変化として出す", () => {
    const before = state(
      unit("ally:1", "ALLY", {
        effects: [effect("e1", "EFF_KEEP", 2), effect("e2", "EFF_GONE", 1)],
      }),
      unit("ally:2", "ALLY"),
      unit("enemy:1", "ENEMY"),
    );
    const after = state(
      unit("ally:1", "ALLY", {
        resources: {
          ap: { current: 1, maximum: 3 },
          pp: { current: 2, maximum: 3 },
          extraGauge: { current: 30, maximum: 100 },
        },
        shields: { physical: 40, energy: 0, untyped: 10 },
        effects: [effect("e1", "EFF_KEEP", 1), effect("e3", "EFF_NEW", 2)],
      }),
      unit("ally:2", "ALLY"),
      unit("enemy:1", "ENEMY", { hp: { current: 0, maximum: 100 }, combatStatus: "DEFEATED" }),
    );

    const rows = projectTraceChanges(before, after, ROSTER);

    expect(rows.map((row) => row.battleUnitId)).toEqual(["ally:1", "enemy:1"]);
    const [ally, enemy] = rows;
    expect(ally).toMatchObject({ displayName: "【先駆】味方A", side: "ALLY", defeated: false });
    expect(ally?.values).toEqual([
      { label: "AP", before: 3, after: 1 },
      { label: "EX", before: 10, after: 30 },
      { label: "シールド", before: 0, after: 50 },
    ]);
    expect(ally?.effects).toEqual([
      { key: "effect:e3", label: "EFF_NEW", change: "added", after: "2T" },
      { key: "effect:e1", label: "EFF_KEEP", change: "remaining", before: "2T", after: "1T" },
      { key: "effect:e2", label: "EFF_GONE", change: "removed", before: "1T" },
    ]);
    expect(enemy?.values).toEqual([{ label: "HP", before: 100, after: 0 }]);
    expect(enemy?.defeated).toBe(true);
  });

  it("marks a unit deployed within the range as deployed without value changes", () => {
    const before = state(unit("ally:1", "ALLY"));
    const after = state(unit("ally:1", "ALLY"), unit("ally:2", "ALLY"));

    const rows = projectTraceChanges(before, after, ROSTER);

    expect(rows).toEqual([
      {
        battleUnitId: "ally:2",
        side: "ALLY",
        displayName: "味方B",
        deployed: true,
        defeated: false,
        values: [],
        effects: [],
      },
    ]);
  });

  it("emits no rows for an unchanged range and falls back to the ID for units missing from the Roster", () => {
    expect(
      projectTraceChanges(state(unit("ally:1", "ALLY")), state(unit("ally:1", "ALLY")), ROSTER),
    ).toEqual([]);
    const rows = projectTraceChanges(
      state(unit("x:9", "ENEMY")),
      state(unit("x:9", "ENEMY", { hp: { current: 50, maximum: 100 } })),
      ROSTER,
    );
    expect(rows[0]?.displayName).toBe("x:9");
  });
});
