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
  type UnitAttributePair,
} from "../battle/model/formation-bonus-calculator.js";
import type { FormationInput } from "../battle/model/formation-input.js";
import { toGlobalCoordinate } from "../battle/model/global-coordinate.js";
import type { Side } from "../shared/side.js";
import { calculateStartingCombatStats } from "../battle/model/starting-combat-stats.js";

/**
 * R-TWR-02 #2・#5・#6: 再登場ユニットの補正はHP・攻撃力・防御力の基本値だけに掛け、
 * 編成補正・適性補正より前に適用する（#3）。効果ではなく基礎値そのものなので、
 * `enhancedBaseStats`も補正後の値を公開する。最大HPはR-ENH-06と同じく1未満を1へ
 * 切り上げ、それ以外は丸めない。
 */
function applyBaseStatMultiplier(baseStats: BaseStats, multiplier: number): BaseStats {
  if (multiplier === 1) {
    return baseStats;
  }
  const maximumHp = baseStats.maximumHp * multiplier;
  return {
    ...baseStats,
    maximumHp: maximumHp < 1 ? 1 : maximumHp,
    attack: baseStats.attack * multiplier,
    defense: baseStats.defense * multiplier,
  };
}

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
 *
 * `baseStatMultipliers` is the per-slot coefficient for HP/attack/defense that
 * the total-war reappearance correction (R-TWR-02) resolves via
 * `resolveReappearanceMultipliers`. Omitted means every slot keeps its base
 * stats (通常戦闘・戦術演習).
 */
export function createBattleParty(
  side: Side,
  formation: FormationInput,
  battleUnitIds: readonly BattleUnitId[],
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>,
  path = "formation",
  baseStatMultipliers?: readonly number[],
): BattleParty {
  if (baseStatMultipliers !== undefined && baseStatMultipliers.length !== formation.slots.length) {
    throw new DomainValidationError(
      `${path}.baseStatMultipliers`,
      `must contain exactly one multiplier per slot: expected ${formation.slots.length}, got ${baseStatMultipliers.length}`,
    );
  }
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

  const unitAttributes: UnitAttributePair[] = slotUnits.map(({ unitDefinition }) => ({
    main: unitDefinition.attribute,
    ...(unitDefinition.subAttribute === undefined ? {} : { sub: unitDefinition.subAttribute }),
  }));
  const formationBonus: FormationBonus = calculateFormationBonus(unitAttributes);

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
      rank: slot.enhancement?.rank,
      gears: slot.enhancement?.gears,
      module: slot.enhancement?.module,
    });
  }

  const members: BattlePartyMember[] = slotUnits.map(({ slot, unitDefinition }, index) => {
    // 強化計算は1参加枠につき1回だけ行い、その結果を`combatStats`の算出元と
    // `enhancedBaseStats`の公開値で共有する。同じ値を2経路で算出すると、片方だけ
    // 変更されたときに両者がずれても双方「仕様どおり」に見えてしまう。
    const baseStats = applyBaseStatMultiplier(
      resolveBaseStats(unitDefinition, slot),
      baseStatMultipliers?.[index] ?? 1,
    );
    return {
      battleUnitId: battleUnitIds[index]!,
      unitDefinitionId: slot.unitDefinitionId,
      attribute: unitDefinition.attribute,
      ...(unitDefinition.subAttribute === undefined
        ? {}
        : { subAttribute: unitDefinition.subAttribute }),
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
