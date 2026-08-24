import { describe, expect, it } from "vitest";
import { createBattleParty } from "./formation-factory.js";
import type { FormationInput } from "../battle/model/formation-input.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type MemoryDefinitionId,
  type UnitDefinitionId,
} from "../catalog/definitions/catalog-ids.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../catalog/definitions/unit-definition.js";
import { createBattleUnitId } from "../shared/ids.js";
import { DomainValidationError } from "../shared/errors.js";
import type { Attribute, PositionRow } from "../catalog/definitions/catalog-enums.js";

function unitDefinition(
  id: string,
  attribute: Attribute,
  positionAptitudes: readonly PositionRow[] = ["FRONT", "BACK"],
): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    category: "PLAYABLE",
    attribute,
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes,
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    metadata: {
      displayName: id,
      characterName: id,
      characterId: id,
      affiliations: [],
      tags: [],
    },
  };
}

function unitsMap(...defs: UnitDefinition[]): ReadonlyMap<UnitDefinitionId, UnitDefinition> {
  return new Map(defs.map((d) => [d.unitDefinitionId, d]));
}

function memoriesMap(
  ...defs: MemoryDefinition[]
): ReadonlyMap<MemoryDefinitionId, MemoryDefinition> {
  return new Map(defs.map((d) => [d.memoryDefinitionId, d]));
}

const NO_MEMORIES = memoriesMap();

describe("createBattleParty — FormationFactory", () => {
  it("UT-R-FRM-FACTORY-001: builds a BattleParty with resolved global coordinates and formation bonus", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.side).toBe("ALLY");
    expect(party.members).toHaveLength(1);
    expect(party.members[0]).toEqual({
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
      enhancedBaseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        criticalDamageBonus: 0.5,
        affinityBonus: 0.25,
        actionSpeed: 10,
        maximumAp: 3,
        maximumPp: 3,
      },
    });
    expect(party.memoryDefinitionIds).toEqual([]);
    expect(party.formationBonus.attackBonus).toBeCloseTo(0);
  });

  it("UT-R-FRM-FACTORY-002 [R-FRM-03]: assigns distinct BattleUnitIds to slots sharing the same UnitDefinitionId (R-FRM-03)", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1"), createBattleUnitId("BU_2")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.members.map((m) => m.battleUnitId)).toEqual([
      createBattleUnitId("BU_1"),
      createBattleUnitId("BU_2"),
    ]);
  });

  it("UT-R-FRM-FACTORY-003: computes the formation bonus from the resolved attributes of every member", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: "CENTER", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_003"),
          position: { column: "RIGHT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_004"),
          position: { column: "LEFT", row: "BACK" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_005"),
          position: { column: "CENTER", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = ["BU_1", "BU_2", "BU_3", "BU_4", "BU_5"].map((id) =>
      createBattleUnitId(id),
    );
    const units = unitsMap(
      unitDefinition("UNIT_001", "AGGRESSIVE"),
      unitDefinition("UNIT_002", "AGGRESSIVE"),
      unitDefinition("UNIT_003", "AGGRESSIVE"),
      unitDefinition("UNIT_004", "AGGRESSIVE"),
      unitDefinition("UNIT_005", "AGGRESSIVE"),
    );

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.formationBonus.attackBonus).toBeCloseTo(0.25);
    expect(party.formationBonus.hpBonus).toBeCloseTo(0.25);
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(12.5);
    expect(party.members[0]!.combatStats.maximumHp).toBeCloseTo(125);
  });

  it("UT-R-FRM-FACTORY-004: rejects a slot referencing an unknown UnitDefinitionId", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_UNKNOWN"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-005: rejects when the battleUnitIds count does not match the slot count", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-007 [R-FRM-03]: rejects duplicate BattleUnitIds across slots (R-FRM-03)", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1"), createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-006: resolves ENEMY-side coordinates using the ENEMY row mapping", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ENEMY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.side).toBe("ENEMY");
    expect(party.members[0]!.globalCoordinate).toEqual({ x: 0, y: 1 });
  });

  it("UT-R-STA-01-018: a mismatched position row applies the aptitude penalty to the member's combat stats", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE", ["FRONT"]));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.members[0]!.combatStats.maximumHp).toBeCloseTo(95);
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(9.5);
    expect(party.members[0]!.combatStats.defense).toBeCloseTo(9.5);
    expect(party.members[0]!.combatStats.criticalRate).toBeCloseTo(0.1);
  });

  it("UT-R-STA-01-019: a referenced Memory's triggeredEffects do not affect the member's starting combat stats (resolved later by the Memory engine, not FormationFactory)", () => {
    const memory = createMemoryDefinition({
      memoryDefinitionId: "MEM_001",
      triggeredEffects: [
        {
          trigger: {
            eventType: "BattleStarted",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
          },
          effectSequence: {
            targetBindings: [
              {
                targetBindingId: "TGT_ALL_ALLIES",
                selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
              },
            ],
            steps: [
              {
                kind: "ACTION",
                target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
                actions: [{ effectActionDefinitionId: "ACT_ATTACK_UP" }],
              },
            ],
          },
        },
      ],
      metadata: { displayName: "Test Memory" },
    });
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, memoriesMap(memory));

    expect(party.members[0]!.combatStats.attack).toBeCloseTo(10);
  });

  it("UT-R-ENH-01-002 [R-ENH-01, R-ENH-03, R-ENH-06] (R-ENH-01 #2/R-ENH-06): a side-level enhancement replaces the R-STA-01 base value for every unit of that side, including units with no enhancement of their own", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
      enhancement: {},
    };
    const battleUnitIds = [createBattleUnitId("BU_1"), createBattleUnitId("BU_2")];
    const units = unitsMap(
      unitDefinition("UNIT_001", "AGGRESSIVE"),
      unitDefinition("UNIT_002", "AGGRESSIVE"),
    );

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    // タイプ装備・モジュールは強化対象へ常時適用される（R-ENH-03）:
    // 攻撃力 (10 + 16020 + 2721) × 1.09、防御力 (10 + 8920 + 1515) × 1.09。
    for (const member of party.members) {
      expect(member.combatStats.attack).toBeCloseTo(20438.59, 4);
      expect(member.combatStats.defense).toBeCloseTo(11385.05, 4);
      expect(member.combatStats.actionSpeed).toBeCloseTo(10, 4);
    }
  });

  it("UT-R-ENH-01-003 (backward compatibility): a formation without an enhancement keeps using the Unit definition's baseStats", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.members[0]!.combatStats.attack).toBeCloseTo(10, 6);
    expect(party.members[0]!.combatStats.defense).toBeCloseTo(10, 6);
  });

  it("UT-R-ENH-06-007: composes academy levels, level growth and gears into the base value", () => {
    const enhanced: UnitDefinition = {
      ...unitDefinition("UNIT_001", "AGGRESSIVE"),
      levelGrowth: { hp: 255, attack: 209, defense: 106, actionSpeed: 2 },
    };
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
          enhancement: { level: 220, gears: [{ stat: "ATTACK", tier: "III", grade: "S" }] },
        },
      ],
      memoryDefinitionIds: [],
      enhancement: {
        academyLevels: { unitTypes: { PHYSICAL: 50 }, attributes: { AGGRESSIVE: 50 } },
      },
    };

    const party = createBattleParty(
      "ALLY",
      formation,
      [createBattleUnitId("BU_1")],
      unitsMap(enhanced),
      NO_MEMORIES,
    );

    // 攻撃力 (10 + 1440 + 2880 + 16020 + 2721 + 20×209) × (1 + 0.09 + 0.0333)
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(30611.0483, 4);
    // 行動速度は学園レベル・タイプ装備・モジュールの対象外: (10 + 20×2) × 1
    expect(party.members[0]!.combatStats.actionSpeed).toBeCloseTo(50, 6);
  });

  it("UT-R-ENH-06-008 (R-ENH-06): the aptitude penalty still applies on top of the enhanced base value", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
      enhancement: {},
    };
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE", ["FRONT"]));

    const party = createBattleParty(
      "ALLY",
      formation,
      [createBattleUnitId("BU_1")],
      units,
      NO_MEMORIES,
    );

    // 適正外配置の -5%（R-STA-01）が、強化後の攻撃力 20438.59 に対して掛かる。
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(19416.6605, 4);
  });

  it("UT-R-FRM-FACTORY-009 [R-ENH-06] (R-ENH-06): exposes the enhanced base stats the member's combat stats were derived from", () => {
    const enhanced: UnitDefinition = {
      ...unitDefinition("UNIT_001", "AGGRESSIVE"),
      levelGrowth: { hp: 255, attack: 209, defense: 106, actionSpeed: 2 },
    };
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
          enhancement: { level: 220, gears: [{ stat: "ATTACK", tier: "III", grade: "S" }] },
        },
      ],
      memoryDefinitionIds: [],
      enhancement: {
        academyLevels: { unitTypes: { PHYSICAL: 50 }, attributes: { AGGRESSIVE: 50 } },
      },
    };

    const party = createBattleParty(
      "ALLY",
      formation,
      [createBattleUnitId("BU_1")],
      unitsMap(enhanced),
      NO_MEMORIES,
    );

    // UT-R-ENH-06-007と同じ強化指定。適性内配置・編成ボーナス不成立のため
    // `combatStats`と一致するが、一致することではなく強化後基本値がそのまま
    // 公開されることを見る。
    expect(party.members[0]!.enhancedBaseStats.attack).toBeCloseTo(30611.0483, 4);
    expect(party.members[0]!.enhancedBaseStats.actionSpeed).toBeCloseTo(50, 6);
    // AP/PPは強化対象外（R-ENH-06）だが基本ステータスの一部として保持する。
    expect(party.members[0]!.enhancedBaseStats.maximumAp).toBe(3);
    expect(party.members[0]!.enhancedBaseStats.maximumPp).toBe(3);
  });

  it("UT-R-FRM-FACTORY-010 [R-ENH-01] (R-ENH-01 #2): a formation without an enhancement exposes the Unit definition's baseStats unchanged", () => {
    const definition = unitDefinition("UNIT_001", "AGGRESSIVE");
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };

    const party = createBattleParty(
      "ALLY",
      formation,
      [createBattleUnitId("BU_1")],
      unitsMap(definition),
      NO_MEMORIES,
    );

    expect(party.members[0]!.enhancedBaseStats).toEqual(definition.baseStats);
  });

  it("UT-R-STA-01-035: the enhanced base stats precede the formation bonus and the aptitude penalty, so only the stats those corrections reach differ", () => {
    // クレバー3人・アグレッシブ2人。役判定はクレバーを除いた2人からでは成立せず
    // （R-BON-01）、補正はR-BON-03の累積段階だけになる: 攻撃+10%・HP+10%・
    // 防御+30%・会心率+15%pt。UNIT_003だけ前衛適性のユニットを後衛へ置き、
    // 適性補正-5%を重ねる。
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: "CENTER", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_003"),
          position: { column: "LEFT", row: "BACK" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_004"),
          position: { column: "CENTER", row: "BACK" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_005"),
          position: { column: "RIGHT", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const units = unitsMap(
      unitDefinition("UNIT_001", "CLEVER"),
      unitDefinition("UNIT_002", "CLEVER"),
      unitDefinition("UNIT_003", "CLEVER", ["FRONT"]),
      unitDefinition("UNIT_004", "AGGRESSIVE"),
      unitDefinition("UNIT_005", "AGGRESSIVE"),
    );

    const party = createBattleParty(
      "ALLY",
      formation,
      [
        createBattleUnitId("BU_1"),
        createBattleUnitId("BU_2"),
        createBattleUnitId("BU_3"),
        createBattleUnitId("BU_4"),
        createBattleUnitId("BU_5"),
      ],
      units,
      NO_MEMORIES,
    );

    const penalised = party.members[2]!;
    // 割合補正ステータスは編成補正と適性補正の両方を受ける（R-STA-01）。
    expect(penalised.enhancedBaseStats.attack).toBeCloseTo(10, 6);
    expect(penalised.combatStats.attack).toBeCloseTo(10.5, 6); // 10 × (1 + 0.10 − 0.05)
    expect(penalised.enhancedBaseStats.maximumHp).toBeCloseTo(100, 6);
    expect(penalised.combatStats.maximumHp).toBeCloseTo(105, 6); // 100 × (1 + 0.10 − 0.05)
    expect(penalised.enhancedBaseStats.defense).toBeCloseTo(10, 6);
    expect(penalised.combatStats.defense).toBeCloseTo(12.5, 6); // 10 × (1 + 0.30 − 0.05)
    // 会心率はパーセントポイント加算で編成補正だけを受ける（適性補正は常に0）。
    expect(penalised.enhancedBaseStats.criticalRate).toBeCloseTo(0.1, 6);
    expect(penalised.combatStats.criticalRate).toBeCloseTo(0.25, 6);
    // 編成補正・適性補正のどちらも及ばないステータスは補正前後で一致する。
    expect(penalised.combatStats.actionSpeed).toBeCloseTo(
      penalised.enhancedBaseStats.actionSpeed,
      6,
    );
    expect(penalised.combatStats.criticalDamageBonus).toBeCloseTo(
      penalised.enhancedBaseStats.criticalDamageBonus,
      6,
    );
    expect(penalised.combatStats.affinityBonus).toBeCloseTo(
      penalised.enhancedBaseStats.affinityBonus,
      6,
    );

    // 適性内に置いたユニットは同じ編成補正だけを受ける（適性補正が乗らない分だけ高い）。
    const unpenalised = party.members[0]!;
    expect(unpenalised.enhancedBaseStats.attack).toBeCloseTo(10, 6);
    expect(unpenalised.combatStats.attack).toBeCloseTo(11, 6); // 10 × (1 + 0.10)
  });

  it("UT-R-FRM-FACTORY-008: rejects a formation referencing an unknown MemoryDefinitionId", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });
});
