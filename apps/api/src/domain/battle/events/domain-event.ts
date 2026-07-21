import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { StateDelta } from "./state-delta.js";
import type { BattleOutcome, CompletionReason } from "../outcome/victory-policy.js";
import type { ReservedActionKind } from "../action/action-queue.js";
import type { CooldownUnit } from "../../catalog/definitions/skill-definition.js";
import type { Side } from "../../shared/side.js";
import type {
  ConsumptionKind,
  CriticalMode,
  DamageType,
  DurationOwner,
  DurationTimeUnit,
  ResourceKind,
  SkillType,
  StatKind,
} from "../../catalog/definitions/catalog-enums.js";
import type {
  EffectActionDefinitionId,
  RuntimeCounterId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterScope } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { BattleId, BattleUnitId } from "../../shared/ids.js";
import type {
  ConditionDefinition,
  ConditionKind,
} from "../../catalog/definitions/condition-definition.js";
import type { EffectActionKind } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectStepDefinition } from "../../catalog/definitions/effect-sequence.js";

/**
 * `08_ドメインイベント.md`「イベントの分類」。M3〜M5はFACT/TIMINGだけを使い、
 * M6で`ExtraGaugeOverflowDiscarded`等のDIAGNOSTICイベントが加わる。
 * `TriggerDefinition.category`（`catalog/definitions/catalog-enums.ts`の別の
 * `EventCategory`）はDIAGNOSTICを含まない — DIAGNOSTICイベントはPS/Memoryの
 * 発動契機になり得ないため、意図的に別の狭い型として保つ。
 */
export type EventCategory = "FACT" | "TIMING" | "DIAGNOSTIC";

/** `08_ドメインイベント.md`「イベントエンベロープ」の共通フィールド。M3実装では`effectSequenceId`は未使用（EffectSequenceイベント自体がM7範囲）。 */
export interface DomainEventEnvelope {
  readonly schemaVersion: number;
  readonly eventId: DomainEventId;
  readonly sequence: number;
  readonly category: EventCategory;
  readonly battleId: BattleId;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly parentEventId?: DomainEventId;
  readonly rootEventId: DomainEventId;
  readonly sourceUnitId?: BattleUnitId;
  readonly sourceSide?: Side;
  readonly targetUnitIds?: readonly BattleUnitId[];
  /** Battle Observationの状態バージョン（`08_ドメインイベント.md`「状態バージョン」）。状態変更を伴わないイベントではBefore/Afterが一致する。 */
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  /** このイベントが所有する状態差分。子イベントとして内訳を表すだけの場合は`undefined`（「複合処理と状態差分の所有」）。 */
  readonly stateDelta?: StateDelta;
}

export interface ResourceRecoveryEntry {
  readonly battleUnitId: BattleUnitId;
  readonly apBefore: number;
  readonly apAfter: number;
  readonly ppBefore: number;
  readonly ppAfter: number;
}

export interface ActionReservationEntry {
  readonly battleUnitId: BattleUnitId;
  readonly reservedActionKind: ReservedActionKind;
  readonly actionSpeed: number;
}

export type EffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

/** `06_戦闘状態遷移.md`「戦闘不能者の除去」: M5時点で予約を除去する原因はこれだけ。 */
export type ActionReservationRemovalReason = "DEFEATED";

export interface TargetBindingSelection {
  readonly targetBindingId: string;
  readonly selectedTargetUnitIds: readonly BattleUnitId[];
}

export interface ActionOrderEntry {
  readonly battleUnitId: BattleUnitId;
  readonly actionSpeed: number;
}

/** eventTypeごとのpayload定義。`08_ドメインイベント.md`の各イベント表「主なpayload」に対応する。 */
export interface BattleDomainEventPayloadMap {
  readonly BattleStarted: {
    readonly turnLimit: number;
    readonly allySlotCount: number;
    readonly enemySlotCount: number;
  };
  readonly TurnStarted: { readonly turnNumber: number };
  readonly ResourcesRecovered: { readonly units: readonly ResourceRecoveryEntry[] };
  readonly ActionQueueCreated: {
    readonly cycleNumber: number;
    readonly reservations: readonly ActionReservationEntry[];
  };
  readonly ActionReservationRemoved: {
    readonly battleUnitId: BattleUnitId;
    readonly reason: ActionReservationRemovalReason;
  };
  /** R-ORD-04: 未行動者だけを新しい行動速度順に並べ直す。予約種別(AS/EX)は変更しない。 */
  readonly ActionQueueReordered: {
    readonly before: readonly ActionOrderEntry[];
    readonly after: readonly ActionOrderEntry[];
  };
  readonly ActionStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly reservedActionType: ReservedActionKind;
    readonly effectiveActionType: EffectiveActionType;
    readonly apBefore: number;
    readonly apAfter: number;
    readonly exBefore: number;
    readonly exAfter: number;
    readonly waitReason?: string;
  };
  readonly ActionWaited: {
    readonly actorUnitId: BattleUnitId;
    readonly waitReason: string;
    readonly consumedResource: ResourceKind;
    readonly consumedAmount: number;
  };
  readonly TargetsSelected: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly bindings: readonly TargetBindingSelection[];
  };
  readonly SkillUseStarting: {
    readonly skillDefinitionId: SkillDefinitionId;
    /**
     * Issue #144 follow-up: `EVENT_PAYLOAD field: "skillType"`を`SkillUseStarting`
     * eventType（`TRIGGER_POSITION_RELATION`対象のSKL_SUIRAN_CHAOS_PS3等）へ
     * 条件付けるproduction Catalog行が、`SkillUseCompleted`（Issue #143）と
     * 同じ理由でこのフィールドを必要とする。
     */
    readonly skillType: SkillType;
    readonly actorUnitId: BattleUnitId;
    readonly targetUnitIds: readonly BattleUnitId[];
    readonly costResource: ResourceKind;
    readonly costAmount: number;
  };
  readonly SkillUseStarted: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly costResource: ResourceKind;
    readonly costAmount: number;
  };
  readonly SkillUseCompleted: {
    readonly skillDefinitionId: SkillDefinitionId;
    /**
     * Issue #143: `RUNTIME_COUNTER_MODULO`対象skillが「AS/EX/PSをN回使用する
     * たびに発動」を`EVENT_PAYLOAD`で判定できるよう追加した。
     */
    readonly skillType: SkillType;
    readonly resolvedStepCount: number;
    readonly targetUnitIds: readonly BattleUnitId[];
  };
  /** R-SKL-06 #1〜#2: ACTION stepのcondition評価前（`08_ドメインイベント.md`「EffectStepStarting」）。BRANCH/RANDOM_BRANCH/REPEATはM7スコープのため`stepKind`は常に"ACTION"。 */
  readonly EffectStepStarting: {
    readonly stepIndex: number;
    readonly stepKind: EffectStepDefinition["kind"];
    readonly conditionKind: ConditionKind;
  };
  /** R-SKL-06 #2: conditionがfalseと評価され、step全体をスキップした時。 */
  readonly EffectStepSkipped: {
    readonly stepIndex: number;
    readonly conditionKind: ConditionKind;
    readonly result: false;
  };
  /** R-SKL-06: stepの解決完了後（`08_ドメインイベント.md`「EffectStepCompleted」）。使用者戦闘不能で中断したstepでは発行しない。 */
  readonly EffectStepCompleted: {
    readonly stepIndex: number;
    readonly resolvedActionCount: number;
  };
  /** R-SKL-06 #4: 対象へEffectAction適用前（`08_ドメインイベント.md`「EffectActionStarting」）。PS/Memory連鎖による対象生存の再検証はこの直前に行う。 */
  readonly EffectActionStarting: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly kind: EffectActionKind;
    readonly targetUnitIds: readonly BattleUnitId[];
  };
  /** R-SKL-06 #5: EffectAction適用完了後（`08_ドメインイベント.md`「EffectActionCompleted」）。`lastResultReference`(R-SKL-08 直前結果)はM7スコープのため未対応。 */
  readonly EffectActionCompleted: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly effectActionKind: EffectActionKind;
    readonly targetUnitIds: readonly BattleUnitId[];
    readonly resultKind: EffectActionResultKind;
  };
  readonly HitConfirmed: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
  };
  readonly CriticalCheckResolved: {
    readonly mode: CriticalMode;
    /** 元会心率（クランプ前）。 */
    readonly baseCriticalRate: number;
    /** 実効会心率（R-CRT-01: `min(100%, max(0%, 元会心率))`）。 */
    readonly effectiveCriticalRate: number;
    readonly result: boolean;
  };
  readonly DamageCalculated: {
    readonly skillDefinitionId: SkillDefinitionId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly attackerAttack: number;
    readonly defenderDefense: number;
    /** R-DMG-01の実効防御力（`defenderDefense * (1 - defenseIgnoreRate)`）。 */
    readonly effectiveDefense: number;
    readonly defenseIgnoreRate: number;
    readonly skillPower: number;
    readonly attributeMultiplier: number;
    readonly criticalMultiplier: number;
    /** R-DMG-01のAction内追加ダメージ倍率。 */
    readonly actionDamageMultiplier: number;
    /** 最終切り捨て・最低1ダメージ（R-DMG-02）を適用する前の値。 */
    readonly preTruncationDamage: number;
    readonly finalDamage: number;
    readonly damageType: DamageType;
  };
  readonly DamageApplied: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
    readonly targetUnitId: BattleUnitId;
    readonly calculatedDamage: number;
    readonly hitPointDamage: number;
    readonly hpBefore: number;
    readonly hpAfter: number;
    readonly defeated: boolean;
  };
  readonly UnitDefeated: {
    readonly unitId: BattleUnitId;
    readonly causeEventId: DomainEventId;
  };
  readonly ActionCompleting: {
    readonly actorUnitId: BattleUnitId;
    readonly effectiveActionType: EffectiveActionType;
  };
  readonly ActionCompleted: {
    readonly actorUnitId: BattleUnitId;
    readonly effectiveActionType: EffectiveActionType;
  };
  /** R-SKL-04: スキル使用開始時にクールタイムを設定する（`cooldown.count`が0のスキルでは発行しない）。 */
  readonly CooldownStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
    readonly initialRemaining: number;
  };
  /** R-SKL-04: 設定した行動・ターンの終了時には減らさず、次回以降の行動・ターン終了で1ずつ減らす。 */
  readonly CooldownReduced: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
    readonly before: number;
    readonly after: number;
  };
  /** R-SKL-04: 残数が0になった時。 */
  readonly CooldownCompleted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly unit: CooldownUnit;
  };
  /** R-SKL-05: チャージ開始をコスト消費・クールタイム設定に続く1つの行動として完了する。 */
  readonly ChargeStarted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly startedActionId: ActionId;
  };
  /** R-SKL-05: チャージ効果発動。チャージ開始とは別の1つの行動として完了する。 */
  readonly ChargeReleased: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly chargeStartActionId: ActionId;
    readonly releaseActionId: ActionId;
  };
  readonly TurnCompleting: { readonly turnNumber: number };
  readonly TurnCompleted: { readonly turnNumber: number };
  readonly BattleCompleted: {
    readonly outcome: BattleOutcome;
    readonly completionReason: CompletionReason;
    readonly completedTurn: number;
  };
  /** R-ACT-04: AP/PP/EXゲージ変更を確定した後の主イベント（`08_ドメインイベント.md:475`）。変化量0では発行しない。 */
  readonly ResourceChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly resource: ResourceKind;
    readonly before: number;
    readonly after: number;
    readonly delta: number;
    readonly reason: ResourceChangeReason;
    readonly causeEventId: DomainEventId;
  };
  /** R-PS-05 #2: PP消費の内訳（`ResourceChanged`の子イベント、`stateDelta`は持たない）。 */
  readonly PassivePointConsumed: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly before: number;
    readonly after: number;
    readonly consumedAmount: number;
  };
  /** R-ACT-03: AP・PP消費による増加の内訳（`ResourceChanged`の子イベント）。 */
  readonly ExtraGaugeIncreased: {
    readonly battleUnitId: BattleUnitId;
    readonly causeResource: "AP" | "PP";
    readonly before: number;
    readonly after: number;
    readonly increasedAmount: number;
  };
  /** R-ACT-03: EX最大値超過分を破棄した時（DIAGNOSTIC、`catalog-event-types.ts`の`DIAGNOSTIC_ONLY_EVENT_TYPES`）。 */
  readonly ExtraGaugeOverflowDiscarded: {
    readonly battleUnitId: BattleUnitId;
    readonly requestedAmount: number;
    readonly actualAmount: number;
    readonly discardedAmount: number;
  };
  /** R-PS-05 #4: 発動済み集合への登録とPP消費後。 */
  readonly PassiveActivated: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly ppBefore: number;
    readonly ppAfter: number;
    readonly exBefore: number;
    readonly exAfter: number;
    readonly triggerEventId: DomainEventId;
  };
  /** R-PS-05 #6: PSのEffectSequence解決後（中断していない場合）。 */
  readonly PassiveResolved: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly resolvedStepCount: number;
  };
  /** R-SKL-01: PS所有者が解決中に戦闘不能になり中断した時。 */
  readonly PassiveInterrupted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly reason: "OWNER_DEFEATED";
    readonly unresolvedEffectCount: number;
  };
  /** R-SKL-01: AS/EX使用者が解決中に戦闘不能になり中断した時。 */
  readonly SkillUseInterrupted: {
    readonly actorUnitId: BattleUnitId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly reason: "ACTOR_DEFEATED";
    readonly resolvedEffectCount: number;
    readonly unresolvedEffectCount: number;
  };
  /**
   * `R-EFF-11`/`08_ドメインイベント.md`「RuntimeCounterイベント」（M6最小実装、
   * Issue #143）。原因イベントの直後・候補抽出より前に採番する例外的な子イベント
   * （「複合処理と状態差分の所有」参照）。`carry`は`CUMULATIVE_DAMAGE_THRESHOLD`の
   * 繰り越し端数（`INCREMENT`では常に0）。`carry`のみが変化した更新でもこの
   * イベント自体は発行するため（追跡性のため、レビュー再々レビュー[P1]）、
   * `valueChanged`（`before !== after`、閾値を実際に跨いだかどうか）を
   * Catalog側の閾値到達PS向けの絞り込み条件として持つ。
   */
  readonly RuntimeCounterChanged: {
    readonly ownerUnitId: BattleUnitId;
    readonly scope: RuntimeCounterScope;
    readonly counter: RuntimeCounterId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly before: number;
    readonly after: number;
    readonly carry: number;
    readonly valueChanged: boolean;
  };
  /** `R-EFF-11`: 解決スコープ終了時、PS/Memory候補スタックが空になった後にcounterを破棄する。 */
  readonly RuntimeCounterReset: {
    readonly ownerUnitId: BattleUnitId;
    readonly scope: RuntimeCounterScope;
    readonly counter: RuntimeCounterId;
    readonly skillDefinitionId: SkillDefinitionId;
    readonly before: number;
  };
  /**
   * `05_ドメインモデル.md`「AppliedEffect」/`08_ドメインイベント.md`「EffectApplied
   * payload」（R-EFF-01）。新しい効果インスタンスを追加した直後に発行する。
   * `kindKey`は`EffectKindKey`（現状`EffectActionDefinitionId`をそのまま使う、
   * `applied-effect.ts`参照）。`durationUnit`/`durationOwner`/`initialRemaining`は
   * `timeLimit`を持つ場合だけ（`durationOwner`はさらに`timeLimit.owner`が
   * 明示された場合だけ）、`consumptionKind`/`consumptionMaxCount`は`consumption`
   * を持つ場合だけ、`expirationConditions`は`expiration`を持つ場合だけ存在する。
   * いずれも持たない場合は戦闘終了まで保持される。
   */
  readonly EffectApplied: {
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly sourceUnitId: BattleUnitId;
    readonly targetUnitId: BattleUnitId;
    readonly duplicate: boolean;
    readonly kindKey: string;
    readonly magnitude: number;
    readonly durationUnit?: DurationTimeUnit;
    readonly durationOwner?: DurationOwner;
    readonly initialRemaining?: number;
    /** インスタンス自身の残り回数（付与直後は`initialRemaining`と同値。R-EFF-04/06の減算は`EffectDurationReduced`が別途表す、EFF-003スコープ）。 */
    readonly remainingCount?: number;
    readonly consumptionKind?: ConsumptionKind;
    readonly consumptionMaxCount?: number;
    /** インスタンス自身の消費残り回数（付与直後は`consumptionMaxCount`と同値。R-EFF-07の消費は`EffectConsumptionChanged`が別途表す、EFF-003スコープ）。 */
    readonly consumptionRemaining?: number;
    readonly expirationConditions?: readonly ConditionDefinition[];
    readonly linkedEffectGroupId: string | null;
    readonly grantedActionId?: ActionId;
    readonly grantedTurnNumber?: number;
    readonly snapshot?: Readonly<Record<string, number>>;
  };
  /**
   * `08_ドメインイベント.md`「EffectiveEffectChanged」: R-EFF-05の重複なし効果で
   * 採用対象が変わった時に、`EffectKindKey`ごとに発行する。`before`/`after`は
   * 採用中のインスタンスID（グループに1件も無ければ`undefined`）。同時に複数の
   * `EffectKindKey`グループの採用対象が変わった場合は、グループごとに別の
   * イベントとして発行する。
   */
  readonly EffectiveEffectChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly kindKey: string;
    readonly before?: EffectInstanceId;
    readonly after?: EffectInstanceId;
  };
  /**
   * `08_ドメインイベント.md`「CombatStatChanged」: R-STA-04の再計算後、実際に
   * 値が変わったstatごとに発行する（変化が無いstatでは発行しない）。
   */
  readonly CombatStatChanged: {
    readonly battleUnitId: BattleUnitId;
    readonly stat: StatKind;
    readonly before: number;
    readonly after: number;
    readonly reason: CombatStatChangeReason;
  };
}

/**
 * `07_戦闘ルール詳細.md` R-STA-04が列挙する再計算契機のうち、現時点で実際に
 * 到達可能なもの（`APPLY_STAT_MOD`の付与、`combat-stat-recalculation-service.ts`）
 * だけを持つ。「更新・解除・失効」「メモリー効果の有効/無効条件の変化」は
 * それぞれEFF-003/M7-001/RES-005のスコープで到達可能になった時点で追加する。
 */
export type CombatStatChangeReason = "EFFECT_APPLIED";

/**
 * `08_ドメインイベント.md`「EffectActionCompleted payload」。M6時点では
 * `REJECTED`(効果適用拒否、`AppliedEffect`前提のM7スコープ)を生成しない。
 */
export type EffectActionResultKind = "APPLIED" | "SKIPPED" | "MISSED" | "REJECTED" | "INTERRUPTED";

/** `08_ドメインイベント.md`「ResourceChanged payload」。 */
export type ResourceChangeReason =
  | "SKILL_COST"
  | "WAIT_COST"
  | "EX_GAIN"
  | "EFFECT_ACTION"
  | "TURN_RECOVERY";

export type BattleDomainEventType = keyof BattleDomainEventPayloadMap;

/**
 * `08_ドメインイベント.md`が定義するイベントの判別共用体。M3の19種別に加え、
 * M5（issue #20）が`ActionWaited`/`ActionReservationRemoved`を追加する。
 */
export type BattleDomainEvent = {
  readonly [Type in BattleDomainEventType]: DomainEventEnvelope & {
    readonly eventType: Type;
    readonly payload: BattleDomainEventPayloadMap[Type];
  };
}[BattleDomainEventType];
