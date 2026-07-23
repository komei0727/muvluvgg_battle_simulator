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
import type { SkillUseId } from "../../shared/event-ids.js";
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
  /**
   * `07_戦闘ルール詳細.md` R-STA-04: 編成補正・配置適性補正だけを反映した、
   * 戦闘中不変の基準値（R-STA-01の`基本値 × (1+編成補正-適性補正)`部分）。
   * `combatStats`（現在の実効値）はAppliedEffectの付与・失効・解除のたびに
   * 再計算されるが、再計算のたびに直前の`combatStats`を新しい基準にすると
   * 誤差が蓄積し、かつ効果の付与順に計算結果が依存してしまう。常にこの不変な
   * 基準へ`R-STA-02`/`R-STA-03`で合成した戦闘中割合補正・固定値補正を適用し
   * 直すことで、`combatStats`は現在有効なAppliedEffect集合だけから毎回同じ
   * 結果を導出できる（`combat-stat-recalculation.ts`参照）。
   */
  readonly baseCombatStats: CombatStats;
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
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`EffectSequence`スコープ（EFF-006、
   * Issue #212）。`EffectSequence`自身は状態を持たないため、実行時識別子として
   * 既存の`SkillUseId`（1回の解決＝1skillUseId）を再利用する。`skillCounters`と
   * 異なり、その解決が完了した時点で必ずキー自体を破棄する
   * （`PassiveActivationRuntime.finalizeEffectSequenceResolution`）。
   */
  readonly effectSequenceCounters?: Readonly<Record<SkillUseId, RuntimeCounterMap>>;
  /** `05_ドメインモデル.md`「AppliedEffect」(R-EFF-01): 個別管理される全効果インスタンス。付与順を保持する。 */
  readonly appliedEffects: readonly AppliedEffect[];
  /** `05_ドメインモデル.md`「MarkerState」(R-EFF-10): 同じmarkerIdにつき対象ごとに1インスタンス。付与順を保持する。 */
  readonly markerStates: readonly MarkerState[];
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
    baseCombatStats: member.combatStats,
    currentHp: createHitPoint(member.combatStats.maximumHp, member.combatStats.maximumHp),
    currentAp: createActionPoint(0, limits.maximumAp),
    currentPp: createPassivePoint(0, limits.maximumPp),
    currentExtraGauge: createExtraGauge(0, limits.maximumExtraGauge),
    maximumAp: limits.maximumAp,
    maximumPp: limits.maximumPp,
    maximumExtraGauge: limits.maximumExtraGauge,
    cooldowns: {},
    appliedEffects: [],
    markerStates: [],
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
