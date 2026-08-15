import { describe, expect, it } from "vitest";
import { resolveAttributeMultiplier } from "../../domain/battle/combat/attribute-affinity-policy.js";
import { resolveCritical } from "../../domain/battle/combat/critical-policy.js";
import { calculateDamage } from "../../domain/battle/combat/damage-calculator.js";
import { calculateStartingCombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createUnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { createPercentage } from "../../domain/shared/percentage.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

/**
 * Issue #476: 会心ダメージボーナス・属性相性ボーナスは、既定値（Q-CAT-05の50%／25%）
 * を**含んだ**ユニットステータスである。R-CRT-02・R-ATR-02が挙げる150%／125%は
 * その既定値込みの結果であり、倍率式の基準は100%でなければならない。
 *
 * 個々のpolicyテストは倍率式だけを、`unit-definition`のテストは既定値だけを固定して
 * おり、「既定値の出所」と「それを消費する倍率式」が食い違っても両者は緑のままだった。
 * ここはその接合部だけを対象にする — Catalog既定値からユニットを起こし、開始
 * ステータスを経て倍率とダメージへ通し、既定値が二重に乗っていないことを固定する。
 */

const ZERO_FORMATION_BONUS = {
  attackBonus: createPercentage(0),
  hpBonus: createPercentage(0),
  defenseBonus: createPercentage(0),
  criticalRateBonus: createPercentage(0),
} as const;

/**
 * `baseStats`から`criticalDamageBonus`・`affinityBonus`を**あえて省く**。
 * production catalogの77ユニット中73体がこの形であり、既定値の適用経路そのものが
 * 検証対象であるため、値を書いてはならない。
 */
const PROBE_DEFINITION = createUnitDefinition({
  unitDefinitionId: "UNIT_DEFAULT_BONUS_PROBE",
  attribute: "AGGRESSIVE",
  unitType: "PHYSICAL",
  role: "PHYSICAL_ATTACKER",
  positionAptitudes: ["FRONT"],
  baseStats: {
    maximumHp: 5000,
    attack: 1000,
    defense: 500,
    criticalRate: 0,
    actionSpeed: 100,
    maximumAp: 3,
    maximumPp: 3,
  },
  extraGaugeMaximum: 100,
  activeSkillDefinitionIds: ["SKL_PROBE_AS1"],
  passiveSkillDefinitionIds: [],
  extraSkillDefinitionId: "SKL_PROBE_EX",
  metadata: {
    displayName: "既定ボーナス検証",
    characterName: "既定ボーナス検証",
    characterId: "CHAR_PROBE",
  },
});

/** 編成補正・適性補正のない開始ステータス。ボーナス2種は既定値のまま通る。 */
const COMBAT_STATS = calculateStartingCombatStats({
  baseStats: PROBE_DEFINITION.baseStats,
  positionAptitudes: PROBE_DEFINITION.positionAptitudes,
  row: "FRONT",
  formationBonus: ZERO_FORMATION_BONUS,
});

/** `calculateDamage`の`formulaContext`を満たすためだけのユニット。 */
function probeUnit(id: string, side: Side): BattleUnit {
  const position = { row: "FRONT", column: "LEFT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: PROBE_DEFINITION.unitDefinitionId,
    attribute: PROBE_DEFINITION.attribute,
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: COMBAT_STATS,
  };
  return createBattleUnit(member, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
}

function guaranteedCriticalMultiplier(): number {
  return resolveCritical(
    "GUARANTEED",
    createPercentage(COMBAT_STATS.criticalRate),
    COMBAT_STATS.criticalDamageBonus,
    new SequenceRandomSource([]),
  ).multiplier;
}

describe("既定ボーナスと倍率基準の整合 (Issue #476)", () => {
  it("IT-AUDIT-BONUS-001 (R-CRT-02 / Q-CAT-05): a unit carrying only the default criticalDamageBonus crits for exactly 150%", () => {
    expect(COMBAT_STATS.criticalDamageBonus).toBeCloseTo(0.5);
    expect(guaranteedCriticalMultiplier()).toBeCloseTo(1.5);
  });

  it("IT-AUDIT-BONUS-002 (R-ATR-02 / Q-CAT-05): a unit carrying only the default affinityBonus hits a favorable defender for exactly 125%", () => {
    expect(COMBAT_STATS.affinityBonus).toBeCloseTo(0.25);
    expect(
      resolveAttributeMultiplier("AGGRESSIVE", "SHY", createPercentage(COMBAT_STATS.affinityBonus)),
    ).toBeCloseTo(1.25);
  });

  it("IT-AUDIT-BONUS-003 (R-DMG-01): a critical hit on a favorable defender multiplies base damage by 1.5 x 1.25, not by the doubled defaults", () => {
    const attacker = probeUnit("U_ATTACKER", "ALLY");
    const target = probeUnit("U_TARGET", "ENEMY");

    const result = calculateDamage({
      // 攻撃力1000 - 防御力500 = 基礎ダメージ500。
      attackerAttack: COMBAT_STATS.attack,
      attackerAttribute: "AGGRESSIVE",
      attackerAffinityBonus: COMBAT_STATS.affinityBonus,
      defenderDefense: COMBAT_STATS.defense,
      defenderAttribute: "SHY",
      defenseIgnoreRate: 0,
      skillPowerFormula: { kind: "SKILL_POWER", power: 1 },
      damageModifiers: [],
      criticalMultiplier: guaranteedCriticalMultiplier(),
      formulaContext: { skillSource: attacker, target, allUnits: [attacker, target] },
    });

    expect(result.attributeMultiplier).toBeCloseTo(1.25);
    // 500 × 1.5 × 1.25 = 937.5 → 切り捨て937（R-DMG-02）。既定値が二重に乗ると
    // 500 × 2.0 × 1.5 = 1500 になる。
    expect(result.finalDamage).toBe(937);
  });
});
