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
  truncateFraction,
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
  /**
   * 現在有効な上限（G-09、M7-002A/Issue #255）。`MODIFY_RESOURCE_CAPACITY`の
   * `AppliedEffect`が1件も無い間は`baseMaximumAp`等と同値であり、付与・失効・解除の
   * たびに`baseMaximum*`から再合成し直す（`resource-capacity-recalculation-service.ts`）。
   * `combatStats`と`baseCombatStats`の関係（R-STA-04）をリソース上限へそのまま
   * 写したもの。
   */
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
  /**
   * Fixed for the whole battle (`UnitDefinition.baseStats`/`extraGaugeMaximum`);
   * carried on the unit so later turns can recover without re-consulting the Catalog.
   * `baseCombatStats`と同じ理由で不変な再合成の基準を別に持つ — 直前の`maximumAp`を
   * 新しい基準にすると上限変更の付与順に結果が依存し、失効時に基準へ戻せない。
   */
  readonly baseMaximumAp: number;
  readonly baseMaximumPp: number;
  readonly baseMaximumExtraGauge: number;
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
  /**
   * R-TEX-06 #4.3: 戦術演習でHPが0へ到達し、ブレイクの解決を当該スキル効果処理の
   * 末尾まで保留している間だけ立つ印（R-TEX-03 #5）。保留窓の間、敵ユニットは
   * 戦闘不能として観測されてはならない — その要求は「網羅の要求であり例示ではない」
   * ため、`isDefeated`という単一の問い合わせ点へ例外を持たせて全判定箇所
   * （対象選択・行動順キュー・R-ACTN-01 #2・演習の終了判定・R-PS-04の発動直前確認・
   * R-FUP-01 #9とR-SUB-02の付与直前再検証）へ一度に効かせる。
   *
   * 効果処理の解決中だけ存在する一時的な印であり、`StateDelta`もBattleState射影も
   * 持たない（`captureBattleState`は戦闘開始時と終了時にしか動かず、そのどちらでも
   * 保留は残っていない — 正常終了・中断のいずれでも当該効果処理の末尾で解決される。
   * R-TEX-06 #7）。
   */
  readonly breakPending?: true;
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
    // R-NUM-02: HP ゲージの最大値は整数でなければならない。`combatStats.maximumHp`
    // は R-STA-01/R-NUM-01 に従い全精度で保持される（比率補正の再計算基準）ため、
    // ゲージへ渡す境界でだけ0方向へ切り捨てる。開始HPは最大値と同じ整数。
    currentHp: createHitPoint(
      truncateFraction(member.combatStats.maximumHp),
      truncateFraction(member.combatStats.maximumHp),
    ),
    currentAp: createActionPoint(0, limits.maximumAp),
    currentPp: createPassivePoint(0, limits.maximumPp),
    currentExtraGauge: createExtraGauge(0, limits.maximumExtraGauge),
    maximumAp: limits.maximumAp,
    maximumPp: limits.maximumPp,
    maximumExtraGauge: limits.maximumExtraGauge,
    baseMaximumAp: limits.maximumAp,
    baseMaximumPp: limits.maximumPp,
    baseMaximumExtraGauge: limits.maximumExtraGauge,
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

/**
 * R-END-02: 全滅判定はHPが0かどうかで決まる（05_ドメインモデル.md「HPが0になった
 * ユニットを即時に戦闘不能とする」）。
 *
 * R-TEX-06 #4.3: ただし戦術演習でブレイクを保留中（`breakPending`）の敵は例外で、
 * HPが0でも戦闘不能として観測させない。保留の間も残りのヒットは命中し、対象選択・
 * 行動順・終了判定のいずれからも生存として見える必要があるためである。
 */
export function isDefeated(unit: BattleUnit): boolean {
  return unit.currentHp === 0 && unit.breakPending !== true;
}

/**
 * R-NUM-02: HPゲージ上の比率（Issue #585）。`currentHp` は既に切り捨て済みの
 * 整数のため、分母を `combatStats.maximumHp`（R-NUM-01・R-STA-01で全精度の
 * まま保持される再計算基準）のまま割ると、満タンでも1.0にならずユニットごとに
 * 値がずれる。他のHPゲージ境界（`heal-application-service.ts`等）と同じ
 * `truncateFraction` を分母にも適用し、切り捨て後の最大HPで揃える。
 * `targeting`/`skill`/`triggering`/`combat` いずれからも依存できる層は
 * `domain/battle/model` だけであり、ここに一本化する。
 */
export function hitPointRatio(unit: BattleUnit): number {
  const maximum = truncateFraction(unit.combatStats.maximumHp);
  return maximum > 0 ? unit.currentHp / maximum : 0;
}

/** R-TEX-03 #5: HP0到達時にブレイクの解決を保留したことを表す印を立てる。 */
export function markBreakPending(unit: BattleUnit): BattleUnit {
  return { ...unit, breakPending: true };
}

/**
 * R-TEX-06 #5: 保留したブレイクを解決する時点で印を外す。印はキー自体を持たない形へ
 * 戻す — 保留中でないユニットと構造的に区別が付いてしまうと、`toEqual`比較や
 * StateDelta非対象フィールドの取り扱いで「保留していた痕跡」が残ってしまう。
 */
export function clearBreakPending(unit: BattleUnit): BattleUnit {
  if (unit.breakPending === undefined) {
    return unit;
  }
  const { breakPending: _pending, ...withoutPending } = unit;
  return withoutPending;
}

export function isBreakPending(unit: BattleUnit): boolean {
  return unit.breakPending === true;
}

/**
 * R-STS-01「状態異常はデバフの一種とする」共通の問い合わせ: `unit`が指定した
 * `StatusKind`のAppliedEffectを現在保持しているか（`duration-expiry-service.ts`
 * が失効済みインスタンスを`appliedEffects`から既に除去しているため、存在＝
 * 有効）。`target-selection-policy.ts`のステルス判定（R-TGT-08）と同じ
 * 「`statusKind`で直接scanする」パターン。
 */
export function activeStatusEffect(
  unit: BattleUnit,
  statusKind: AppliedEffect["statusKind"],
): AppliedEffect | undefined {
  return unit.appliedEffects.find((effect) => effect.statusKind === statusKind);
}

/** R-STS-02: 気絶中かどうか（R-ACT-01 #1「気絶中：待機。チャージ中ならチャージをキャンセルする」）。 */
export function isStunned(unit: BattleUnit): boolean {
  return activeStatusEffect(unit, "STUN") !== undefined;
}

/** R-STS-03: 凍結中かどうか（R-ACT-01 #2「凍結中：待機。チャージを維持する」）。 */
export function isFrozen(unit: BattleUnit): boolean {
  return activeStatusEffect(unit, "FREEZE") !== undefined;
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
