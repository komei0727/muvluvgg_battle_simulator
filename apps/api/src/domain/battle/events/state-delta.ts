import type { BattleStatus } from "../model/battle-status.js";
import type {
  AppliedEffect,
  ContinuousDamageState,
  DamageModifierState,
  EffectImmunityState,
  HealingLinkState,
  PiercingModifierState,
  ShieldState,
  StatusEffectDetails,
  SubUnitState,
} from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { CooldownUnit } from "../../catalog/definitions/skill-definition.js";
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

/** `Battle.result`と同じ形。`battle.js`からの循環importを避けるため独立に定義する。 */
export type BattleResultSnapshot = VictoryResult & { readonly completedTurn: number };

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
 * 範囲。TGT-004フェーズ1、Issue #167、PR #234再レビューで`SKILL_USE`を追加した
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
    ...(effect.sourceId !== undefined ? { sourceUnitId: effect.sourceId } : {}),
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
    ...(effect.healingLink !== undefined ? { healingLink: effect.healingLink } : {}),
    ...(effect.damageModifier !== undefined ? { damageModifier: effect.damageModifier } : {}),
    ...(effect.piercing !== undefined ? { piercing: effect.piercing } : {}),
    ...(effect.shield !== undefined ? { shield: effect.shield } : {}),
    ...(effect.subUnit !== undefined ? { subUnit: effect.subUnit } : {}),
    ...(effect.continuousDamage !== undefined ? { continuousDamage: effect.continuousDamage } : {}),
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
    ...(marker.sourceId !== undefined ? { sourceUnitId: marker.sourceId } : {}),
    ...(marker.sourceSide !== undefined ? { sourceSide: marker.sourceSide } : {}),
    stackCount: marker.stackCount,
    stackMax: marker.stackMax,
    ...(duration !== undefined ? { duration } : {}),
    ...(marker.duration.consumptionRemaining !== undefined
      ? { consumptionRemaining: marker.duration.consumptionRemaining }
      : {}),
  };
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
   * 設定し直す（`CooldownStarted`）」ことを表す。R-SKL-04/PR #141のとおり、行動外の
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
   * レビュー指摘[P1]: `after: undefined`は`RuntimeCounterReset`によるcounter
   * キー自体の削除を表す（`0`という値ではなく、実状態の`resetRuntimeCounter`が
   * キーを`delete`することと対応させる — `after: 0`のままだと独立Reducerが
   * `{ counter: 0 }`を復元してしまい、実状態の`{}`と一致しなくなる）。
   */
  readonly skillCounters?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /**
   * `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（`carry`）専用の差分
   * （レビュー再々レビュー[P2]、Issue #143: `carry`はStateDeltaから除外されて
   * いたため、次回の閾値判定に必要な内部状態がStateDelta単独から復元できな
   * かった）。`skillCounters`と同じ2段キーだが独立に変化するため別フィールドと
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
  /** 勝敗確定（`BattleCompleted`）のみが持つ。`before`は常に`undefined`（未確定）。 */
  readonly result?: ValueChange<BattleResultSnapshot | undefined>;
}
