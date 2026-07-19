import { describe, expect, it } from "vitest";
import { captureBattleState, captureUnitRoster } from "./battle-state-snapshot.js";
import { createActionId } from "../../shared/event-ids.js";
import { createBattle } from "./battle.js";
import { createBattleUnit, type BattleUnitResourceLimits } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createTurnLimit } from "../model/turn-limit.js";
import type { Side } from "../../shared/side.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";

const CHARGE_SKILL: SkillDefinition = {
  skillDefinitionId: createSkillDefinitionId("SKL_A"),
  skillType: "AS",
  cost: { resource: "AP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [],
  counterUpdates: [],
  resolution: {
    kind: "CHARGE",
    targetBindings: [],
    steps: [],
    chargeRelease: { targetBindings: [], steps: [] },
  },
  cooldown: { unit: "ACTION", count: 0 },
  traits: {
    priorityAttack: false,
    simultaneousActivationLimited: false,
    exclusiveActivationGroupId: null,
    accuracy: { guaranteedHit: false },
    piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
  },
  requiredCapabilities: [],
  metadata: { displayName: "Charge", tags: [] },
};

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
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions: new Map(),
      skillDefinitions: new Map(),
    });

    const snapshot = captureBattleState(battle);

    expect(snapshot.status).toBe("READY");
    expect(snapshot.currentTurn).toBe(0);
    expect(snapshot.units[ally.battleUnitId]).toEqual({ hp: 100, ap: 0, pp: 0, extraGauge: 0 });
    expect(snapshot.units[enemy.battleUnitId]).toEqual({ hp: 100, ap: 0, pp: 0, extraGauge: 0 });
  });

  it("UT-STATE-SNAPSHOT-003: carries each unit's real cooldowns (including their ACTION/TURN setting scope) and charge, instead of dropping them (10_API設計.md BattleUnitStateResponse)", () => {
    const skillA = createSkillDefinitionId("SKL_A");
    const skillB = createSkillDefinitionId("SKL_B");
    const chargeAction = createActionId("action-1");
    const ally = {
      ...unit("ally-1", "ALLY"),
      cooldowns: {
        [skillA]: { unit: "ACTION" as const, remaining: 2, setActionId: chargeAction },
        [skillB]: { unit: "TURN" as const, remaining: 1, setTurnNumber: 3 },
      },
      charge: { skill: CHARGE_SKILL, startedActionId: chargeAction },
    };
    const enemy = unit("enemy-1", "ENEMY");
    const battle = createBattle(createBattleId("battle-1"), [ally], [enemy], createTurnLimit(3), {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions: new Map(),
      skillDefinitions: new Map(),
    });

    const snapshot = captureBattleState(battle);

    expect(snapshot.units[ally.battleUnitId]!.cooldowns).toEqual({
      [skillA]: { unit: "ACTION", remaining: 2, setActionId: chargeAction },
      [skillB]: { unit: "TURN", remaining: 1, setTurnNumber: 3 },
    });
    expect(snapshot.units[ally.battleUnitId]!.charge).toEqual({
      skillDefinitionId: skillA,
      startedActionId: chargeAction,
    });
    expect(snapshot.units[enemy.battleUnitId]!.cooldowns).toBeUndefined();
    expect(snapshot.units[enemy.battleUnitId]!.charge).toBeUndefined();
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
      {
        activeSkillsByUnit: new Map(),
        exSkillByUnit: new Map(),
        effectActions: new Map(),
        unitDefinitions: new Map(),
        skillDefinitions: new Map(),
      },
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
