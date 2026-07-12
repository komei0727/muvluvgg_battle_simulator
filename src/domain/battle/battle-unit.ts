import type { UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { UnitDefinition } from "../catalog/unit-definition.js";
import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
} from "./resource-gauge.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "./battle-party.js";
import type { FormationPosition } from "./formation-input.js";
import type { GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import type { CombatStats } from "./starting-combat-stats.js";

/**
 * `05_ドメインモデル.md` の BattleUnit: 戦闘へ参加している個々のユニットの
 * 戦闘中可変状態。`BattlePartyMember` の不変な配置・開始ステータスに、
 * HP/AP/PP/EXの可変リソースを重ねる。
 */
export interface BattleUnit {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly side: Side;
  readonly position: FormationPosition;
  readonly globalCoordinate: GlobalCoordinate;
  readonly combatStats: CombatStats;
  readonly currentHp: number;
  readonly currentAp: number;
  readonly currentPp: number;
  readonly currentExtraGauge: number;
  /** Fixed for the whole battle (`UnitDefinition.baseStats`/`extraGaugeMaximum`); carried on the unit so later turns can recover without re-consulting the Catalog. */
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
}

export interface BattleUnitResourceLimits {
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
}

/** Battle開始時点: HPは満タン、AP/PP/EXは0（初回ターン開始のAP/PP回復で満タンになる）。 */
export function createBattleUnit(
  member: BattlePartyMember,
  side: Side,
  limits: BattleUnitResourceLimits,
): BattleUnit {
  return {
    battleUnitId: member.battleUnitId,
    unitDefinitionId: member.unitDefinitionId,
    side,
    position: member.position,
    globalCoordinate: member.globalCoordinate,
    combatStats: member.combatStats,
    currentHp: createHitPoint(member.combatStats.maximumHp, member.combatStats.maximumHp),
    currentAp: createActionPoint(0, limits.maximumAp),
    currentPp: createPassivePoint(0, limits.maximumPp),
    currentExtraGauge: createExtraGauge(0, limits.maximumExtraGauge),
    maximumAp: limits.maximumAp,
    maximumPp: limits.maximumPp,
    maximumExtraGauge: limits.maximumExtraGauge,
  };
}

/**
 * `09_アプリケーション設計.md`: BattleParty各メンバーのAP/PP/EX最大値を
 * `UnitDefinition` から取得して `BattleUnit` へ変換する。参照するIDは
 * SimulationPreflightValidatorで存在確認済みである前提だが、防御的に
 * 欠落を検出する。
 */
export function createBattleUnitsFromParty(
  party: BattleParty,
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): BattleUnit[] {
  return party.members.map((member, index) => {
    const unitDefinition = units.get(member.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        `party.members[${index}].unitDefinitionId`,
        `references an unknown UnitDefinitionId: "${member.unitDefinitionId}"`,
      );
    }
    return createBattleUnit(member, party.side, {
      maximumAp: unitDefinition.baseStats.maximumAp,
      maximumPp: unitDefinition.baseStats.maximumPp,
      maximumExtraGauge: unitDefinition.extraGaugeMaximum,
    });
  });
}

/** R-END-02: 全滅判定はHPが0かどうかで決まる（05_ドメインモデル.md「HPが0になったユニットを即時に戦闘不能とする」）。 */
export function isDefeated(unit: BattleUnit): boolean {
  return unit.currentHp === 0;
}

/**
 * 06_戦闘状態遷移.md TURN_STARTING #2: 戦闘可能な全ユニットのAPとPPを最大値まで
 * 回復する。EXゲージはターン開始時に回復しない（08_ドメインイベント.md
 * ResourcesRecovered payload）。
 */
export function recoverTurnResources(unit: BattleUnit): BattleUnit {
  if (isDefeated(unit)) {
    return unit;
  }
  return {
    ...unit,
    currentAp: createActionPoint(unit.maximumAp, unit.maximumAp),
    currentPp: createPassivePoint(unit.maximumPp, unit.maximumPp),
  };
}
