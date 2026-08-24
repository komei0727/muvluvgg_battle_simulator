import type { BattleStatus } from "../model/battle-status.js";
import type { ExerciseStateSnapshot } from "../model/exercise-runtime.js";
import type {
  AppliedEffect,
  ContinuousDamageState,
  CoverState,
  DamageModifierState,
  DeathSurvivalState,
  EffectImmunityState,
  HealingLinkState,
  PiercingModifierState,
  DamageLinkState,
  ReflectState,
  ShieldState,
  StatusEffectDetails,
  SubUnitState,
  TargetRedirectState,
} from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { CooldownUnit } from "../../catalog/definitions/skill-definition.js";
import type { ExerciseEndResult } from "../outcome/exercise-end-policy.js";
import type { VictoryResult } from "../outcome/victory-policy.js";
import type {
  MarkerId,
  RuntimeCounterId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectImmunityCategory, StatKind } from "../../catalog/definitions/catalog-enums.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type {
  ActionId,
  EffectInstanceId,
  MarkerInstanceId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";

export interface ValueChange<T> {
  readonly before: T;
  readonly after: T;
}

/** 通常戦闘の結果（R-END-02）。勝敗と終了理由を持つ。 */
export type NormalBattleResultSnapshot = VictoryResult & { readonly completedTurn: number };

/**
 * 演習結果（R-TEX-10 #1）: 終了理由、終了ターン、総スコア、ブレイク回数。勝利・敗北は
 * 持たない。ブレイク履歴は集約が持たず、`UnitBroken`の投影として出力する（同 #2）。
 */
export type ExerciseBattleResultSnapshot = ExerciseEndResult & {
  readonly completedTurn: number;
  readonly totalScore: number;
  readonly breakCount: number;
};

/**
 * `Battle.result`と同じ形（`battle.js`が`BattleResult`として再輸出する）。型の正本を
 * こちら側に置くのは、`state-delta.js`から`battle.js`をimportすると循環になるためである。
 */
export type BattleResultSnapshot = NormalBattleResultSnapshot | ExerciseBattleResultSnapshot;

/**
 * 演習結果を判別する。演習結果だけが総スコアを持ち、通常戦闘の結果だけが勝敗を持つため、
 * 判別子フィールドを足さずに構造で判別できる（R-TEX-10 #1）。
 */
export function isExerciseBattleResult(
  result: BattleResultSnapshot,
): result is ExerciseBattleResultSnapshot {
  return "totalScore" in result;
}

/**
 * `06_戦闘状態遷移.md`「クールタイム状態」の外部公開形。`setActionId`/`setTurnNumber`は
 * 「設定した同じ行動・ターンでは減算しない」(R-SKL-04)の設定scopeを、`unit`に応じて
 * どちらか一方だけ持つ（`cooldown-state.ts`の`CooldownEntry`と同じXOR）。
 * `UnitStateDelta.cooldowns`にも同じ形で運ばれ、`08_ドメインイベント.md`
 * 「状態復元」の`stateTransitions`単体（`events`のlogLevelによる間引きに
 * 依存しない）から独立Reducerで復元できる。
 */
export interface CooldownState {
  readonly unit: CooldownUnit;
  readonly remaining: number;
  readonly setActionId?: ActionId;
  readonly setTurnNumber?: number;
}

/** `06_戦闘状態遷移.md`「チャージ状態」の外部公開形。 */
export interface ChargeState {
  readonly skillDefinitionId: SkillDefinitionId;
  readonly startedActionId: ActionId;
}

/**
 * `10_API設計.md`「EffectStateResponse」の外部公開形のうち、R-EFF-01/R-EFF-05が
 * 要求する値を持つ（`category`/`stackMode`/構造化`value`はEffectStateResponseへの
 * wire変換でありResponse Mapperの責務）。`isEffective`はR-EFF-05の選択結果
 * （`effective-effect-selector.ts`）— 重複あり効果は常に`true`、重複なし効果は
 * 同種グループの最強1件だけが`true`になる。`duration`は
 * `AppliedEffect.duration.definition.timeLimit.unit`が`ACTION`/`TURN`/`SKILL_USE`
 * の場合だけ持つ（`10_API設計.md`の`EffectStateResponse.duration`が表現できる
 * 範囲。TGT-004フェーズ1（Issue #167）で`SKILL_USE`を追加した
 * — `BATTLE`/`HIT`は引き続き対象外）。`consumptionRemaining`（EFF-003、
 * R-EFF-07）は`10_API設計.md`の`EffectStateResponse`が公開契約として持たない
 * 内部専用フィールド — `EffectConsumptionChanged`のstateDelta・独立Reducer
 * 復元のためだけに保持する。
 */
export interface EffectSnapshot {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectDefinitionId: string;
  /** R-MEM-04（Issue #179）: Memory由来の効果インスタンスは付与者ユニットを持たず`sourceSide`を持つ。 */
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly kindKey: string;
  readonly duplicate: boolean;
  readonly isEffective: boolean;
  readonly magnitude: number;
  /** TGT-004フェーズ3（Issue #167、R-ACTN-03）: `APPLY_STATUS`由来の効果だけが持つ。 */
  readonly statusKind?: StatusKind;
  /** M7-004（Issue #183）: `statusKind`がEVASION/BLIND/FREEZE/DAMAGE_IMMUNITYの場合だけ持つ。 */
  readonly statusDetails?: StatusEffectDetails;
  /**
   * M7-001B（Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`由来の効果だけが持つ。
   * `blockedCount`（新規付与を実際に拒否した回数）は`EffectApplicationRejected`の
   * stateDelta・独立Reducer復元のためだけに保持する内部専用フィールド
   * （`10_API設計.md`のEffectStateResponseは公開しない、`consumptionRemaining`と同じ扱い）。
   */
  readonly immunity?: EffectImmunityState;
  /** M7-004（ON_ATTACK_BONUS_DAMAGE_BUFF、Issue #183）: `APPLY_ATTACK_DAMAGE_BONUS`由来の効果だけが持つ。 */
  readonly isAttackDamageBonus?: true;
  /** R-FUP-01（Issue #474）: `APPLY_FOLLOW_UP_ATTACK`由来の効果だけが持つ。 */
  readonly isFollowUpAttack?: true;
  /**
   * M7-005-HEAL-LINK（Issue #229、R-HEAL-04）: `APPLY_HEALING_LINK`由来の効果だけが
   * 持つ。転送先・転送率が復元されないと、独立Reducerで復元した状態に対する回復が
   * 転送されず、`HealingTransferred`のStateDeltaと矛盾するため同一性比較へ含める。
   */
  readonly healingLink?: HealingLinkState;
  /**
   * DMG-002（Issue #192、R-DMG-04）: `APPLY_DAMAGE_MOD`由来の効果だけが持つ。
   * `magnitude`（補正値）だけでは「どの向き・ダメージ種別・条件で適用される補正か」
   * を復元できず、独立Reducerで復元した状態に対する`composeDamageModifiers`が
   * 実戦闘と別の倍率を出してしまうため、`healingLink`と同じ理由で同一性比較へ含める。
   */
  readonly damageModifier?: DamageModifierState;
  /**
   * DMG-004（Issue #194、R-SHD-01）: `APPLY_SHIELD`由来の効果だけが持つ。
   * `remaining`はヒットごとの吸収（`ShieldConsumed`）と行動ごとの漸減で変化するため、
   * `damageModifier`と同じ理由で同一性比較へ含める — これが無いと独立Reducerで
   * 復元した状態のシールドプールが実戦闘と食い違い、以後のダメージ振り分けが
   * 再現しない。
   */
  readonly shield?: ShieldState;
  /**
   * DMG-003（Issue #196、R-DMG-03）: `APPLY_PIERCING_MOD`由来の効果だけが持つ。
   * `magnitude`は3つの率のどれも表さない（この効果はmagnitudeを使わない）ため、
   * `damageModifier`と同じ理由で3率そのものを同一性比較へ含める — これが無いと
   * 独立Reducerで復元した状態の`composePiercing`が実戦闘と別の貫通率を出す。
   */
  readonly piercing?: PiercingModifierState;
  /**
   * DMG-005（Issue #190、R-SUB-01/02）: `APPLY_SUBUNIT`由来の効果だけが持つ
   * 残耐久力と追加ダメージ定義。`durability`はヒットごとの吸収（`SubUnitDamaged`）で
   * 変化し、`additionalDamage`は所持者の攻撃へ加わる追加ヒットの内容を決めるため、
   * `shield`と同じ理由で同一性比較へ含める — これが無いと独立Reducerで復元した
   * 状態のサブユニット吸収と追加ダメージが実戦闘と食い違う。
   */
  readonly subUnit?: SubUnitState;
  /**
   * DMG-008（Issue #189、R-DOT-01〜04）: `APPLY_CONTINUOUS_DAMAGE`由来の効果だけが
   * 持つ種別・ダメージタイプ。種別が復元されないと、独立Reducerで復元した状態の
   * 炎上重複数（R-DOT-03）と毒の再付与統合（R-DOT-04）が実戦闘と食い違うため、
   * `shield`と同じ理由で同一性比較へ含める。
   */
  readonly continuousDamage?: ContinuousDamageState;
  /**
   * DMG-006（Issue #188、R-INT-01〜03）: 防御介入系の4kind由来の効果だけが持つ。
   * 引き寄せ先・肩代わり者は付与時点で解決したユニットIDであり、反射量・耐えHPは
   * Catalog Formulaを焼き込んだものである。どれも復元されないと独立Reducerで復元した
   * 状態の介入解決（`defensive-intervention-policy.ts`）が実戦闘と食い違うため、
   * `shield`と同じ理由で同一性比較へ含める。
   */
  readonly targetRedirect?: TargetRedirectState;
  readonly cover?: CoverState;
  readonly reflect?: ReflectState;
  readonly deathSurvival?: DeathSurvivalState;
  /**
   * DMG-007（Issue #187、R-INT-01 #3／R-LNK-01〜03）: `APPLY_DAMAGE_LINK`由来の効果
   * だけが持つ。リンク先は付与時点で解決したユニットIDで、`linkRate`はCatalog値を
   * 焼き込んだものである。復元されないと独立Reducerで復元した状態のリンク解決
   * （`defensive-intervention-policy.ts`の`selectDamageLinks`）が実戦闘と食い違う
   * ため、防御介入系の4状態と同じ理由で同一性比較へ含める。
   */
  readonly damageLink?: DamageLinkState;
  /**
   * M7-001E（Issue #248、R-EFF-02/03）: `effect-category-classifier.ts`が付与時点に
   * 確定した分類集合（`AppliedEffect.categories`と同じソート済み配列）。
   * `TARGET_HAS_EFFECT`条件の判定入力であるため、欠落・破損したまま復元されると
   * 独立Reducerの状態でだけ条件成立が変わる — `statusKind`/`shield`と同じ理由で
   * 同一性比較へ含める。
   */
  readonly categories: readonly EffectImmunityCategory[];
  /**
   * M7-001E（Issue #248）: `APPLY_STAT_MOD`由来の効果だけが持つ補正対象stat。
   * `TARGET_HAS_EFFECT.statKinds`のstat単位の絞り込みが復元後も同じ結果になるよう、
   * `categories`と同じ理由で同一性比較へ含める。
   */
  readonly statModStat?: StatKind;
  /**
   * DMG-008（Issue #189、R-DOT-01）: `AppliedEffect.snapshot`（継続ダメージの
   * `sourceAttack`など、付与時に固定した値）。付与者の攻撃力が復元されないと、
   * 独立Reducerで復元した状態の継続ダメージが実戦闘と別の量を出す
   * （毒の上限`付与時攻撃力 × 100%`が特に効く）ため、`shield`と同じ理由で
   * 同一性比較へ含める。R-DOT-04の統合（`EffectMerged`）でも書き換わる。
   */
  readonly snapshot?: Readonly<Record<string, number>>;
  readonly duration?: {
    readonly unit: "ACTION" | "TURN" | "SKILL_USE";
    readonly remaining: number;
  };
  readonly consumptionRemaining?: number;
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: ActionId;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」`AppliedEffect`スコープの公開値
   * （EFF-005/Issue #162）。`skillCounters`と同じく内部端数（`carry`）は含まない
   * （`battle-state-snapshot.ts`の`skillCounters`公開規約と同じ）。
   * `definition.counterUpdates`を持つ場合だけ存在する。
   */
  readonly counters?: Readonly<Record<RuntimeCounterId, number>>;
}

/**
 * `AppliedEffect`（Domain）から`EffectSnapshot`（`stateDelta`/`BattleUnitSnapshot`
 * 共通の外部公開形）を導出する。`captureBattleState`と`EffectApplied`を記録する
 * `effect-grant-service.ts`が同じ変換を共有し、`finalState.effects`と
 * `stateTransitions`由来の復元結果が常に同じ形になるようにする。`isEffective`は
 * `AppliedEffect`自身が持たない導出値（R-EFF-05）のため、呼び出し側
 * （`effective-effect-selector.ts`の選択結果）が渡す。
 */
export function toEffectSnapshot(effect: AppliedEffect, isEffective: boolean): EffectSnapshot {
  const timeLimit = effect.duration.definition.timeLimit;
  const duration =
    (timeLimit?.unit === "ACTION" ||
      timeLimit?.unit === "TURN" ||
      timeLimit?.unit === "SKILL_USE") &&
    effect.duration.timeLimitRemaining !== undefined
      ? { unit: timeLimit.unit, remaining: effect.duration.timeLimitRemaining }
      : undefined;
  return {
    effectInstanceId: effect.effectInstanceId,
    effectDefinitionId: effect.effectActionDefinitionId,
    ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
    ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
    kindKey: effect.kindKey,
    duplicate: effect.duplicate,
    isEffective,
    magnitude: effect.magnitude,
    ...(effect.statusKind !== undefined ? { statusKind: effect.statusKind } : {}),
    ...(effect.statusDetails !== undefined ? { statusDetails: effect.statusDetails } : {}),
    ...(effect.immunity !== undefined ? { immunity: effect.immunity } : {}),
    ...(effect.isAttackDamageBonus !== undefined
      ? { isAttackDamageBonus: effect.isAttackDamageBonus }
      : {}),
    ...(effect.isFollowUpAttack !== undefined ? { isFollowUpAttack: effect.isFollowUpAttack } : {}),
    ...(effect.healingLink !== undefined ? { healingLink: effect.healingLink } : {}),
    ...(effect.damageModifier !== undefined ? { damageModifier: effect.damageModifier } : {}),
    ...(effect.piercing !== undefined ? { piercing: effect.piercing } : {}),
    ...(effect.shield !== undefined ? { shield: effect.shield } : {}),
    ...(effect.subUnit !== undefined ? { subUnit: effect.subUnit } : {}),
    ...(effect.continuousDamage !== undefined ? { continuousDamage: effect.continuousDamage } : {}),
    ...(effect.targetRedirect !== undefined ? { targetRedirect: effect.targetRedirect } : {}),
    ...(effect.cover !== undefined ? { cover: effect.cover } : {}),
    ...(effect.reflect !== undefined ? { reflect: effect.reflect } : {}),
    ...(effect.damageLink !== undefined ? { damageLink: effect.damageLink } : {}),
    ...(effect.deathSurvival !== undefined ? { deathSurvival: effect.deathSurvival } : {}),
    categories: effect.categories,
    ...(effect.statModStat !== undefined ? { statModStat: effect.statModStat } : {}),
    ...(effect.snapshot !== undefined ? { snapshot: effect.snapshot } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(effect.duration.consumptionRemaining !== undefined
      ? { consumptionRemaining: effect.duration.consumptionRemaining }
      : {}),
    appliedTurnNumber: effect.appliedTurnNumber,
    ...(effect.appliedActionId !== undefined ? { appliedActionId: effect.appliedActionId } : {}),
    ...(effect.duration.counters !== undefined
      ? {
          counters: Object.fromEntries(
            Object.entries(effect.duration.counters).map(([counter, entry]) => [
              counter as RuntimeCounterId,
              entry.value,
            ]),
          ),
        }
      : {}),
  };
}

/**
 * `05_ドメインモデル.md`「MarkerState」/R-EFF-10の外部公開形。`EffectSnapshot`と
 * 同じ設計（`duration`はACTION/TURN単位の場合だけ、`consumptionRemaining`は
 * 消費条件を持つ場合だけ存在する）。`sourceUnitId`は直近の付与者（インスタンス
 * 識別には使わない、`marker-state.ts`参照）。
 */
export interface MarkerSnapshot {
  readonly markerInstanceId: MarkerInstanceId;
  readonly markerId: MarkerId;
  /** R-MEM-04（M7-008、Issue #176）: Memory由来の付与は`sourceSide`だけを持つ。 */
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly stackCount: number;
  readonly stackMax: number | null;
  readonly duration?: { readonly unit: "ACTION" | "TURN"; readonly remaining: number };
  readonly consumptionRemaining?: number;
}

/**
 * `MarkerState`（Domain）から`MarkerSnapshot`（`stateDelta`共通の外部公開形）を
 * 導出する。`toEffectSnapshot`と同じ役割 — `MarkerApplied`/`MarkerUpdated`/
 * `MarkerRemoved`を記録するサービスと`captureBattleState`が同じ変換を共有する。
 */
export function toMarkerSnapshot(marker: MarkerState): MarkerSnapshot {
  const timeLimit = marker.duration.definition.timeLimit;
  const duration =
    (timeLimit?.unit === "ACTION" || timeLimit?.unit === "TURN") &&
    marker.duration.timeLimitRemaining !== undefined
      ? { unit: timeLimit.unit, remaining: marker.duration.timeLimitRemaining }
      : undefined;
  return {
    markerInstanceId: marker.markerInstanceId,
    markerId: marker.markerId,
    ...(marker.sourceUnitId !== undefined ? { sourceUnitId: marker.sourceUnitId } : {}),
    ...(marker.sourceSide !== undefined ? { sourceSide: marker.sourceSide } : {}),
    stackCount: marker.stackCount,
    stackMax: marker.stackMax,
    ...(duration !== undefined ? { duration } : {}),
    ...(marker.duration.consumptionRemaining !== undefined
      ? { consumptionRemaining: marker.duration.consumptionRemaining }
      : {}),
  };
}

export interface BattleUnitSnapshot {
  readonly hp: number;
  readonly ap: number;
  readonly pp: number;
  readonly extraGauge: number;
  /**
   * G-09（M7-002A／Issue #255）: `MODIFY_RESOURCE_CAPACITY`の付与・失効・解除の
   * たびに再合成される現在の上限。`BattleUnitRosterEntry.maximumAp`等は
   * `startBattle`前に1回だけ取る不変な開始時点の値であり、この時点の実効値とは
   * 別物（`combatStats`と`BattleUnitRosterEntry.combatStats`の関係と同じ）。
   */
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
  /** R-STA-04: AppliedEffectの付与・失効・解除のたびに再計算される現在の実効値。常に存在する（`BattleUnitRosterEntry.combatStats`は不変な開始時点のスナップショット）。 */
  readonly combatStats: CombatStats;
  /**
   * R-STA-04の2層構造の基礎側（編成補正・適性補正だけを反映した基準値）。通常戦闘では
   * 戦闘中不変だが、戦術演習のブレイク強化（R-TEX-04、`UnitRevived`が所有する
   * `units.<id>.baseCombatStats`差分）だけがこれを書き換えるため、可変状態として
   * 射影する — これが無いと独立Reducerが強化差分を適用する先を持たず、
   * `initialState + 全差分 = finalState`が演習で成立しない。
   */
  readonly baseCombatStats: CombatStats;
  /** 空でない場合だけ持つ(`captureBattleState`はクールタイムが1件も無いユニットへ`{}`を書かない)。 */
  readonly cooldowns?: Readonly<Record<SkillDefinitionId, CooldownState>>;
  readonly charge?: ChargeState;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`SkillRuntime`スコープ（M6最小実装、
   * Issue #143）。`cooldowns`と同様、1件も持たないユニットへは`{}`を書かない。
   */
  readonly skillCounters?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, number>>>
  >;
  /**
   * `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（`carry`）専用の射影
   * （Issue #143）。`carry`が0の（＝一度も繰り越しが
   * 発生していない、または`INCREMENT`の）counterはキー自体を持たない
   * （`skillCounters`と違い0はデフォルト値として省略する）。
   */
  readonly skillCounterCarry?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, number>>>
  >;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`EffectSequence`スコープ（EFF-006、
   * Issue #212）。`skillCounters`と同じ射影だが、1段目のキーが`SkillUseId`
   * （1回の解決を識別する既存の実行時識別子）である点だけが異なる。その解決が
   * 完了した時点で必ずキー自体が削除されるため、進行中の解決だけが持つ。
   */
  readonly effectSequenceCounters?: Readonly<
    Record<SkillUseId, Readonly<Record<RuntimeCounterId, number>>>
  >;
  /** `effectSequenceCounters`の`carry`専用射影。`skillCounterCarry`と同じ規約。 */
  readonly effectSequenceCounterCarry?: Readonly<
    Record<SkillUseId, Readonly<Record<RuntimeCounterId, number>>>
  >;
  /** `05_ドメインモデル.md`「AppliedEffect」(R-EFF-01)。1件も無いユニットへは`[]`ではなくキー自体を持たない。 */
  readonly effects?: readonly EffectSnapshot[];
  /** `05_ドメインモデル.md`「MarkerState」(R-EFF-10)。1件も無いユニットへは`[]`ではなくキー自体を持たない。 */
  readonly markers?: readonly MarkerSnapshot[];
}

/**
 * `08_ドメインイベント.md`「状態復元」のinitialState/finalStateに相当する、
 * Battleの可変状態だけを抜き出した不変スナップショット。`result`は勝敗確定後
 * だけ持つ（`Battle.result`と同じく、READY/RUNNING中は`undefined`）。
 */
export interface BattleStateSnapshot {
  readonly status: BattleStatus;
  readonly currentTurn: number;
  readonly units: Readonly<Record<BattleUnitId, BattleUnitSnapshot>>;
  readonly result?: BattleResultSnapshot;
  /** 戦術演習だけが持つ演習状態（R-TEX-02／R-TEX-10）。通常戦闘ではキー自体を持たない。 */
  readonly exercise?: ExerciseStateSnapshot;
}

/** `08_ドメインイベント.md`「StateDelta」: 変更した項目だけを持つ。 */
export interface UnitStateDelta {
  readonly hp?: ValueChange<number>;
  readonly ap?: ValueChange<number>;
  readonly pp?: ValueChange<number>;
  readonly extraGauge?: ValueChange<number>;
  /**
   * G-09（M7-002A／Issue #255）: `ResourceCapacityChanged`が単独で所有する、
   * AP/PP/EXゲージの**最大値**の差分。`ap`/`pp`/`extraGauge`（現在値）とは
   * 独立に変化するため別キーにする。HPの最大値は`MAXIMUM_HP` CombatStatであり、
   * `combatStats.maximumHp`が同じ役割を担う。
   */
  readonly maximumAp?: ValueChange<number>;
  readonly maximumPp?: ValueChange<number>;
  readonly maximumExtraGauge?: ValueChange<number>;
  /**
   * R-SKL-04: SkillDefinitionIdをキーとする、変更されたクールタイムだけを持つ。
   * `unit`(ACTION/TURN)はスキル使用開始時から不変だが、ReducerはCatalogを
   * 参照できないため、初回設定(`CooldownStarted`)以降の全ての変更でも
   * 一緒に運ぶ（`before`のみのValueChangeでは初回設定時に`unit`を復元できない）。
   * `setActionId`/`setTurnNumber`は設定(`CooldownStarted`)時だけ`unit`に
   * 応じてどちらか一方を持ち、以降の変更(`CooldownReduced`等)では省略する
   * （設定scope自体は変わらないため、独立Reducerは既存値を保持する）。
   *
   * `establishesScope`（Issue #248で表面化した既存欠陥）は「この差分がエントリ自体を
   * 設定し直す（`CooldownStarted`）」ことを表す。R-SKL-04のとおり、行動外の
   * トップレベルイベントから発動したPSは`unit: "ACTION"`でも設定scopeを持たない
   * エントリになるため、`setActionId`/`setTurnNumber`の**不在**そのものが意味を持つ。
   * この印が無いと独立Reducerは不在を「省略（既存値を保持）」と解釈するしかなく、
   * 古い`setActionId`を残して実状態と食い違っていた。
   */
  readonly cooldowns?: Readonly<
    Record<
      SkillDefinitionId,
      {
        readonly unit: CooldownUnit;
        readonly setActionId?: ActionId;
        readonly setTurnNumber?: number;
        readonly establishesScope?: true;
      } & ValueChange<number>
    >
  >;
  /** R-SKL-05: チャージ開始(`undefined`→値)・解放/中断(値→`undefined`)。 */
  readonly charge?: ValueChange<ChargeState | undefined>;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`SkillRuntime`スコープ（M6最小実装、
   * Issue #143）。`SkillDefinitionId`→`RuntimeCounterId`の2段キーで、変更された
   * counterの`value`だけを持つ（`RuntimeCounterChanged`/`RuntimeCounterReset`が
   * 単独で所有する`stateDelta`）。値が変化しなかった更新（carryのみの変化）では
   * このキー自体を持たない（`skillCounterCarry`を参照）。
   *
   * `after: undefined`は`RuntimeCounterReset`によるcounter
   * キー自体の削除を表す（`0`という値ではなく、実状態の`resetRuntimeCounter`が
   * キーを`delete`することと対応させる — `after: 0`のままだと独立Reducerが
   * `{ counter: 0 }`を復元してしまい、実状態の`{}`と一致しなくなる）。
   */
  readonly skillCounters?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /**
   * `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（`carry`）専用の差分
   * （Issue #143: `carry`をStateDeltaから除外すると、次回の閾値判定に必要な
   * 内部状態がStateDelta単独から復元できない）。`skillCounters`と同じ2段キーだが独立に変化するため別フィールドと
   * する（`INCREMENT`は常に`carry`が0のままのためこのキーを持たない）。
   * `after: undefined`は`RuntimeCounterReset`によるキー削除を表す。
   */
  readonly skillCounterCarry?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`EffectSequence`スコープ（EFF-006、
   * Issue #212）。`skillCounters`と同じ2段キー・規約だが、キーが`SkillDefinitionId`
   * ではなく`SkillUseId`（1回の解決を識別する既存の実行時識別子）である点だけが
   * 異なる。`before: undefined`は初回加算、`after: undefined`は解決完了時の
   * `RuntimeCounterReset`によるキー削除を表す。
   */
  readonly effectSequenceCounters?: Readonly<
    Record<SkillUseId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /** `effectSequenceCounters`の`carry`専用差分。`skillCounterCarry`と同じ規約。 */
  readonly effectSequenceCounterCarry?: Readonly<
    Record<SkillUseId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /**
   * `EffectInstanceId`をキーとする、変更された`AppliedEffect`だけを持つ
   * （R-EFF-01）。`skillCounters`と同じ規約: `before: undefined`は新規付与
   * （`EffectApplied`）を表す。`after: undefined`（失効・解除）や両方存在する
   * 場合（残り回数変更・重複なしグループの採用切替）は後続Issue（EFF-002/003）
   * が発行するイベントの`stateDelta`が使う — このIssueでは新規付与だけを扱う。
   */
  readonly effects?: Readonly<Record<EffectInstanceId, ValueChange<EffectSnapshot | undefined>>>;
  /**
   * `MarkerInstanceId`をキーとする、変更された`MarkerState`だけを持つ
   * （R-EFF-10）。`effects`と同じ規約: `before: undefined`は新規付与
   * （`MarkerApplied`）、`after: undefined`は除去（`MarkerRemoved`）、両方
   * 存在する場合はスタック/Duration変更（`MarkerUpdated`）を表す。
   */
  readonly markers?: Readonly<Record<MarkerInstanceId, ValueChange<MarkerSnapshot | undefined>>>;
  /**
   * R-STA-04: `CombatStatChanged`が単独で所有する差分。実際に値が変わった
   * `CombatStats`のフィールドだけをキーとして持つ（`hp`/`ap`と同じ「変更した
   * 項目だけを記録する」規約）。
   */
  readonly combatStats?: Readonly<Partial<Record<keyof CombatStats, ValueChange<number>>>>;
  /**
   * R-TEX-04: ブレイク強化が書き換えた**基礎**戦闘ステータスの差分（`UnitRevived`が
   * 単独で所有する）。`combatStats`（戦闘中ステータス）とは別のキーにする —
   * R-STA-04の2層構造で、基礎側の書き換えと、そこへ効果を合成し直した結果
   * （`CombatStatChanged`が所有する`combatStats`差分）は独立に起きるためである。
   * 通常戦闘では`baseCombatStats`が不変のため一切現れない。
   */
  readonly baseCombatStats?: Readonly<Partial<Record<keyof CombatStats, ValueChange<number>>>>;
}

/**
 * `08_ドメインイベント.md`「StateDelta」: 変更した戦闘ユニットIDや状態区分だけを
 * キーとして記録する。配列位置に依存するJSON Patchではなく、安定したドメインID
 * で差分対象を識別する。
 */
export interface StateDelta {
  readonly units?: Readonly<Record<BattleUnitId, UnitStateDelta>>;
  readonly turnNumber?: ValueChange<number>;
  readonly battleStatus?: ValueChange<BattleStatus>;
  /**
   * 結果確定（`BattleCompleted`）のみが持つ。`before`は常に`undefined`（未確定）。
   * 戦術演習では勝敗ではなく演習結果（R-TEX-10 #1）を運ぶ。
   */
  readonly result?: ValueChange<BattleResultSnapshot | undefined>;
  /**
   * `08_ドメインイベント.md`「戦術演習イベント」の演習状態差分。戦闘モードが
   * `TACTICAL_EXERCISE`のときだけ発生する。累計スコア差分は
   * `ExerciseScoreAccumulated`（加算、R-TEX-02 #4）と`ExerciseScoreDeducted`
   * （減算、同 #5/#6）が分け合い、各イベントが自分の差分を単独で所有する。
   */
  readonly exercise?: ExerciseStateDelta;
}

/** 演習状態（累計スコア・ブレイク回数）の差分。通常戦闘では発生しない。 */
export interface ExerciseStateDelta {
  readonly totalScore?: ValueChange<number>;
  /** R-TEX-03 #4: ブレイク回数。`UnitBroken`が単独で所有する（累計スコアとは独立に変わる）。 */
  readonly breakCount?: ValueChange<number>;
}
