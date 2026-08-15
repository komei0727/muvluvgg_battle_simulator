import type { Attribute } from "../catalog/definitions/catalog-enums.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../catalog/definitions/memory-definition.js";
import type { BaseStats, UnitDefinition } from "../catalog/definitions/unit-definition.js";
import { calculateEnhancedBaseStats } from "../battle/model/enhanced-base-stats-calculator.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "../battle/model/battle-party.js";
import {
  calculateFormationBonus,
  type FormationBonus,
} from "../battle/model/formation-bonus-calculator.js";
import type { FormationInput } from "../battle/model/formation-input.js";
import { toGlobalCoordinate } from "../battle/model/global-coordinate.js";
import type { Side } from "../shared/side.js";
import { calculateStartingCombatStats } from "../battle/model/starting-combat-stats.js";

/**
 * Builds a `BattleParty` from an already-validated `FormationInput`
 * (`R-FRM-01`〜`R-FRM-04`, checked upstream by `validateFormationInput`).
 * `battleUnitIds` is caller-assigned, one per slot in the same order
 * (`09_アプリケーション設計.md`: 参加枠ごとに一意なIDを割り当てるのはApplication層の責務).
 * The same `UnitDefinitionId` can appear in multiple slots, but each slot
 * must keep a distinct `BattleUnitId` (R-FRM-03) — a duplicate is rejected
 * rather than silently collapsing two participants' HP/skill/effect/event
 * ownership onto one id.
 *
 * `memories` is used only to validate that every `formation.memoryDefinitionIds`
 * entry resolves to a known `MemoryDefinition` (R-FRM-*). It does not affect
 * `combatStats`: Memory's `triggeredEffects` (the sole representation of
 * Memory stat correction, `APPLY_STAT_MOD` included) are resolved later by
 * the Memory triggering engine, not by `FormationFactory`
 * (M3スコープ外「Memory triggeredEffectsの解決」).
 */
export function createBattleParty(
  side: Side,
  formation: FormationInput,
  battleUnitIds: readonly BattleUnitId[],
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>,
  path = "formation",
): BattleParty {
  if (battleUnitIds.length !== formation.slots.length) {
    throw new DomainValidationError(
      `${path}.battleUnitIds`,
      `must contain exactly one BattleUnitId per slot: expected ${formation.slots.length}, got ${battleUnitIds.length}`,
    );
  }

  const seenBattleUnitIds = new Set<BattleUnitId>();
  battleUnitIds.forEach((battleUnitId, index) => {
    if (seenBattleUnitIds.has(battleUnitId)) {
      throw new DomainValidationError(
        `${path}.battleUnitIds[${index}]`,
        `duplicates a BattleUnitId already assigned to another slot: "${battleUnitId}"`,
      );
    }
    seenBattleUnitIds.add(battleUnitId);
  });

  formation.memoryDefinitionIds.forEach((memoryDefinitionId, index) => {
    if (!memories.has(memoryDefinitionId)) {
      throw new DomainValidationError(
        `${path}.memoryDefinitionIds[${index}]`,
        `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
      );
    }
  });

  const slotUnits = formation.slots.map((slot, index) => {
    const unitDefinition = units.get(slot.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        `${path}.slots[${index}].unitDefinitionId`,
        `references an unknown UnitDefinitionId: "${slot.unitDefinitionId}"`,
      );
    }
    return { slot, unitDefinition };
  });

  const attributes: Attribute[] = slotUnits.map(({ unitDefinition }) => unitDefinition.attribute);
  const formationBonus: FormationBonus = calculateFormationBonus(attributes);

  /**
   * R-ENH-01 #2/R-ENH-06: 陣営の強化指定があるときだけ、R-STA-01の基本値を
   * 強化後基本ステータスへ差し替える。指定が無い陣営は`baseStats`をそのまま使う
   * （従来動作。既存リクエストの結果を変えない）。編成ボーナス・適性補正の
   * 適用規則は差し替えの前後で変わらない。
   */
  function resolveBaseStats(
    unitDefinition: UnitDefinition,
    slot: FormationInput["slots"][number],
  ): BaseStats {
    const enhancement = formation.enhancement;
    if (enhancement === undefined) {
      return unitDefinition.baseStats;
    }
    return calculateEnhancedBaseStats(unitDefinition, {
      academyLevels: enhancement.academyLevels,
      level: slot.enhancement?.level,
      gears: slot.enhancement?.gears,
    });
  }

  const members: BattlePartyMember[] = slotUnits.map(({ slot, unitDefinition }, index) => {
    // 強化計算は1参加枠につき1回だけ行い、その結果を`combatStats`の算出元と
    // `enhancedBaseStats`の公開値で共有する。同じ値を2経路で算出すると、片方だけ
    // 変更されたときに両者がずれても双方「仕様どおり」に見えてしまう。
    const baseStats = resolveBaseStats(unitDefinition, slot);
    return {
      battleUnitId: battleUnitIds[index]!,
      unitDefinitionId: slot.unitDefinitionId,
      attribute: unitDefinition.attribute,
      position: slot.position,
      globalCoordinate: toGlobalCoordinate(side, slot.position),
      combatStats: calculateStartingCombatStats({
        baseStats,
        positionAptitudes: unitDefinition.positionAptitudes,
        row: slot.position.row,
        formationBonus,
      }),
      enhancedBaseStats: baseStats,
    };
  });

  return {
    side,
    members,
    memoryDefinitionIds: formation.memoryDefinitionIds,
    formationBonus,
  };
}
