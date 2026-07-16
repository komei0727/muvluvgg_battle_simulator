import type { ActionId, DomainEventId, ResolutionScopeId, SkillUseId } from "./event-ids.js";
import type { StateDelta } from "./state-delta.js";
import type { BattleOutcome, CompletionReason } from "../victory-policy.js";
import type { ReservedActionKind } from "../action-queue.js";
import type { CooldownUnit } from "../../catalog/skill-definition.js";
import type { Side } from "../side.js";
import type { CriticalMode, DamageType, ResourceKind } from "../../catalog/catalog-enums.js";
import type { EffectActionDefinitionId, SkillDefinitionId } from "../../catalog/catalog-ids.js";
import type { BattleId, BattleUnitId } from "../../shared/ids.js";

/** `08_ドメインイベント.md`「イベントの分類」。M3が発行するイベントはFACT/TIMINGだけを使う。 */
export type EventCategory = "FACT" | "TIMING";

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
    readonly resolvedStepCount: number;
    readonly targetUnitIds: readonly BattleUnitId[];
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
}

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
