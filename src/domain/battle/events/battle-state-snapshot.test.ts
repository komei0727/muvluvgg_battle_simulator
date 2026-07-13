import { describe, expect, it } from "vitest";
import { captureBattleState, captureUnitRoster } from "./battle-state-snapshot.js";
import { createBattle } from "../battle.js";
import { createBattleUnit, type BattleUnitResourceLimits } from "../battle-unit.js";
import type { BattlePartyMember } from "../battle-party.js";
import { toGlobalCoordinate } from "../global-coordinate.js";
import { createTurnLimit } from "../turn-limit.js";
import type { Side } from "../side.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createUnitDefinitionId } from "../../catalog/catalog-ids.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 2, maximumExtraGauge: 100 };

function unit(id: string, side: Side) {
  const position = { column: "LEFT" as const, row: "FRONT" as const };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

describe("captureBattleState", () => {
  it("UT-STATE-SNAPSHOT-001: captures status, current turn, and each unit's HP/AP/PP/EX gauge", () => {
    const ally = unit("ally-1", "ALLY");
    const enemy = unit("enemy-1", "ENEMY");
    const battle = createBattle(createBattleId("battle-1"), [ally], [enemy], createTurnLimit(3), {
      activeSkillsByUnit: new Map(),
      effectActions: new Map(),
    });

    const snapshot = captureBattleState(battle);

    expect(snapshot.status).toBe("READY");
    expect(snapshot.currentTurn).toBe(0);
    expect(snapshot.units[ally.battleUnitId]).toEqual({ hp: 100, ap: 0, pp: 0, extraGauge: 0 });
    expect(snapshot.units[enemy.battleUnitId]).toEqual({ hp: 100, ap: 0, pp: 0, extraGauge: 0 });
  });
});

describe("captureUnitRoster", () => {
  it("UT-STATE-SNAPSHOT-002: lists ally units before enemy units, each in slot order, with the static per-unit facts an API response needs (10_API設計.md BattleUnitStateResponse)", () => {
    const ally1 = unit("ally-1", "ALLY");
    const ally2 = unit("ally-2", "ALLY");
    const enemy1 = unit("enemy-1", "ENEMY");
    const battle = createBattle(
      createBattleId("battle-1"),
      [ally1, ally2],
      [enemy1],
      createTurnLimit(3),
      { activeSkillsByUnit: new Map(), effectActions: new Map() },
    );

    const roster = captureUnitRoster(battle);

    expect(roster.map((entry) => entry.battleUnitId)).toEqual([
      ally1.battleUnitId,
      ally2.battleUnitId,
      enemy1.battleUnitId,
    ]);
    expect(roster[0]).toEqual({
      battleUnitId: ally1.battleUnitId,
      unitDefinitionId: ally1.unitDefinitionId,
      side: "ALLY",
      position: ally1.position,
      globalCoordinate: ally1.globalCoordinate,
      combatStats: ally1.combatStats,
      maximumAp: ally1.maximumAp,
      maximumPp: ally1.maximumPp,
      maximumExtraGauge: ally1.maximumExtraGauge,
    });
    expect(roster[2]!.side).toBe("ENEMY");
  });
});
