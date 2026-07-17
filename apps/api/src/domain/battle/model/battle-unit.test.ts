import { describe, expect, it } from "vitest";
import {
  createBattleUnit,
  createBattleUnitsFromParty,
  isDefeated,
  recoverTurnResources,
  type BattleUnitResourceLimits,
} from "./battle-unit.js";
import type { BattleParty, BattlePartyMember } from "./battle-party.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { createPercentage } from "../../shared/percentage.js";

function member(overrides: Partial<BattlePartyMember> = {}): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId("BU_1"),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
    ...overrides,
  };
}

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

describe("createBattleUnit", () => {
  it("UT-BATTLE-UNIT-001: starts at full HP but zero AP/PP/EX (06_戦闘状態遷移.md: TURN_STARTING recovers before use)", () => {
    const unit = createBattleUnit(member(), "ALLY", LIMITS);

    expect(unit.currentHp).toBe(100);
    expect(unit.currentAp).toBe(0);
    expect(unit.currentPp).toBe(0);
    expect(unit.currentExtraGauge).toBe(0);
    expect(unit.side).toBe("ALLY");
    expect(unit.battleUnitId).toBe(createBattleUnitId("BU_1"));
    expect(unit.maximumAp).toBe(3);
    expect(unit.maximumPp).toBe(3);
    expect(unit.maximumExtraGauge).toBe(100);
  });

  it("UT-BATTLE-UNIT-002: carries the member's position, coordinate, and combat stats through unchanged", () => {
    const unit = createBattleUnit(member(), "ENEMY", LIMITS);

    expect(unit.position).toEqual({ column: "LEFT", row: "FRONT" });
    expect(unit.globalCoordinate).toEqual({ x: 0, y: 2 });
    expect(unit.combatStats.attack).toBe(10);
  });
});

describe("isDefeated", () => {
  it("UT-BATTLE-UNIT-003: a unit at full HP is not defeated", () => {
    const unit = createBattleUnit(member(), "ALLY", LIMITS);
    expect(isDefeated(unit)).toBe(false);
  });

  it("UT-BATTLE-UNIT-004: a unit at 0 HP is defeated (05_ドメインモデル.md: HPが0になったユニットを即時に戦闘不能とする)", () => {
    const unit = { ...createBattleUnit(member(), "ALLY", LIMITS), currentHp: 0 };
    expect(isDefeated(unit)).toBe(true);
  });
});

describe("recoverTurnResources", () => {
  it("UT-BATTLE-UNIT-005: recovers AP and PP to their maximum (06_戦闘状態遷移.md TURN_STARTING #2)", () => {
    const unit = createBattleUnit(member(), "ALLY", LIMITS);

    const recovered = recoverTurnResources(unit);

    expect(recovered.currentAp).toBe(3);
    expect(recovered.currentPp).toBe(3);
  });

  it("UT-BATTLE-UNIT-006: does not recover EX gauge on turn start (08_ドメインイベント.md: EXゲージはターン開始時に回復しないため含めない)", () => {
    const unit = createBattleUnit(member(), "ALLY", LIMITS);

    const recovered = recoverTurnResources(unit);

    expect(recovered.currentExtraGauge).toBe(0);
  });

  it("UT-BATTLE-UNIT-007: leaves a defeated unit untouched (06_戦闘状態遷移.md: 戦闘可能な全ユニットのAPとPPを最大値まで回復する)", () => {
    const unit = { ...createBattleUnit(member(), "ALLY", LIMITS), currentHp: 0, currentAp: 0 };

    const recovered = recoverTurnResources(unit);

    expect(recovered.currentAp).toBe(0);
    expect(recovered).toEqual(unit);
  });
});

function unitDefinition(id: string, maximumAp: number, maximumPp: number): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp,
      maximumPp,
    },
    extraGaugeMaximum: 50,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

describe("createBattleUnitsFromParty", () => {
  it("UT-BATTLE-UNIT-008: pulls each member's AP/PP/EX maximums from its UnitDefinition", () => {
    const party: BattleParty = {
      side: "ALLY",
      members: [member({ battleUnitId: createBattleUnitId("BU_1") })],
      memoryDefinitionIds: [],
      formationBonus: {
        attackBonus: createPercentage(0),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    };
    const units = new Map<UnitDefinitionId, UnitDefinition>([
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001", 4, 2)],
    ]);

    const battleUnits = createBattleUnitsFromParty(party, units);

    expect(battleUnits).toHaveLength(1);
    expect(battleUnits[0]!.side).toBe("ALLY");
    expect(battleUnits[0]!.maximumAp).toBe(4);
    expect(battleUnits[0]!.maximumPp).toBe(2);
    expect(battleUnits[0]!.maximumExtraGauge).toBe(50);
  });

  it("UT-BATTLE-UNIT-009: rejects a member whose UnitDefinitionId is absent from the given map (defensive; preflight should already guarantee this)", () => {
    const party: BattleParty = {
      side: "ALLY",
      members: [member({ unitDefinitionId: createUnitDefinitionId("UNIT_MISSING") })],
      memoryDefinitionIds: [],
      formationBonus: {
        attackBonus: createPercentage(0),
        hpBonus: createPercentage(0),
        defenseBonus: createPercentage(0),
        criticalRateBonus: createPercentage(0),
      },
    };

    expect(() => createBattleUnitsFromParty(party, new Map())).toThrow(DomainValidationError);
  });
});
