import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId, UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { ActiveCharge } from "./charge-state.js";
import type { CooldownMap } from "./cooldown-state.js";
import type { RuntimeCounterMap } from "./runtime-counter-state.js";
import type { AppliedEffect } from "./applied-effect.js";
import type { MarkerState } from "./marker-state.js";
import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
} from "./resource-gauge.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "./battle-party.js";
import type { FormationPosition } from "./formation-input.js";
import type { GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { CombatStats } from "./starting-combat-stats.js";

/**
 * `05_ドメインモデル.md` の BattleUnit: 戦闘へ参加している個々のユニットの
 * 戦闘中可変状態。`BattlePartyMember` の不変な配置・開始ステータスに、
 * HP/AP/PP/EXの可変リソースを重ねる。
 */
export interface BattleUnit {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly attribute: Attribute;
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
  /** R-SKL-04: スキルごとのクールタイム状態。SkillDefinitionIdをキーとする。 */
  readonly cooldowns: CooldownMap;
  /** R-SKL-05: 発動待ちのチャージ。同時に1つだけ持てる。 */
  readonly charge?: ActiveCharge;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`SkillRuntime`スコープ（M6最小実装、
   * Issue #143）。所有スキルの`SkillDefinitionId`をキーとする。未使用のスキルは
   * キー自体を持たない（`cooldowns`と異なり、大半のスキルがcounterを持たない
   * ため`charge`と同様に省略可能とする）。
   */
  readonly skillCounters?: Readonly<Record<SkillDefinitionId, RuntimeCounterMap>>;
  /** `05_ドメインモデル.md`「AppliedEffect」（Issue #23）。付与順を保持する（`effect-duplicate-resolution.ts`の重複なし選択が配列順をtie-breakに使う）。 */
  readonly appliedEffects: readonly AppliedEffect[];
  /** `05_ドメインモデル.md`「MarkerState」（Issue #23）。 */
  readonly markers: readonly MarkerState[];
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
    attribute: member.attribute,
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
    cooldowns: {},
    appliedEffects: [],
    markers: [],
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
 * `lifecycle/action-resolution-shared.ts`の`requireUnit`と同じ実装。
 * `domain/battle/effects`は`domain/battle/lifecycle`に依存できない
 * （モジュール境界、eslint.config.mjs）ため、`model`側に複製を持つ。
 */
export function requireUnit(units: readonly BattleUnit[], id: BattleUnitId): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError("battleUnitId", `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
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
