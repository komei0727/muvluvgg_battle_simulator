import type { EventCategory } from "./catalog-enums.js";

/**
 * Closed `eventType` → `category` map, transcribed from every event table in
 * `08_ドメインイベント.md` (戦闘・ターン、行動順キュー、行動、スキル、
 * EffectSequence、チャージ、PS、Memory、命中・会心、ダメージ、回復、効果、
 * Marker、リソース・クールタイム、RuntimeCounter、ユニット). `trigger-definition.ts`
 * leaves `eventType` as an open string and defers this closed-list check here
 * (Catalog integrity concern, issue #7) because it needs the full event
 * catalog, which lives outside `14_Catalog定義スキーマ.md`.
 */
export const EVENT_TYPE_CATEGORIES: Readonly<Record<string, EventCategory>> = {
  // 戦闘・ターンイベント
  BattleStarted: "FACT",
  TurnStarted: "FACT",
  ResourcesRecovered: "FACT",
  TurnCompleting: "TIMING",
  TurnCompleted: "FACT",
  BattleCompleted: "FACT",
  // 行動順キューイベント
  ActionQueueCreated: "FACT",
  ActionQueueReordered: "FACT",
  ActionReservationRemoved: "FACT",
  // 行動イベント
  ActionStarted: "FACT",
  ActionWaited: "FACT",
  ActionCompleting: "TIMING",
  ActionCompleted: "FACT",
  // スキルイベント
  SkillUseStarting: "TIMING",
  SkillUseStarted: "FACT",
  SkillUseCompleted: "FACT",
  SkillUseInterrupted: "FACT",
  SkillMissed: "FACT",
  TargetsSelected: "FACT",
  // EffectSequenceイベント
  TargetBindingsResolved: "FACT",
  EffectStepStarting: "TIMING",
  EffectStepCompleted: "FACT",
  RandomBranchSelected: "FACT",
  EffectActionStarting: "TIMING",
  EffectActionCompleted: "FACT",
  // チャージイベント
  ChargeStarted: "FACT",
  ChargeReleaseReady: "FACT",
  ChargeReleased: "FACT",
  ChargeCancelled: "FACT",
  ChargeHeldByFreeze: "FACT",
  // PSイベント
  PassiveActivated: "FACT",
  PassiveResolved: "FACT",
  PassiveInterrupted: "FACT",
  // Memoryイベント
  MemoryTriggered: "FACT",
  MemoryResolved: "FACT",
  MemoryModifierApplied: "FACT",
  // 命中・会心イベント
  BlindnessCheckResolved: "FACT",
  EvasionActivated: "FACT",
  HitConfirmed: "FACT",
  CriticalCheckResolved: "FACT",
  // ダメージイベント
  UnitBeingAttacked: "TIMING",
  DamageWillBeApplied: "TIMING",
  DamageCalculated: "FACT",
  ShieldConsumed: "FACT",
  SubUnitDamaged: "FACT",
  HitPointReduced: "FACT",
  DamageApplied: "FACT",
  LinkedDamageGenerated: "FACT",
  DamageRedirected: "FACT",
  ReflectedDamageGenerated: "FACT",
  // 回復イベント
  HealApplied: "FACT",
  // 効果イベント
  EffectApplied: "FACT",
  EffectApplicationRejected: "FACT",
  EffectMerged: "FACT",
  EffectiveEffectChanged: "FACT",
  EffectRemoved: "FACT",
  EffectExpired: "FACT",
  EffectConsumptionChanged: "FACT",
  // Markerイベント
  MarkerApplied: "FACT",
  MarkerUpdated: "FACT",
  MarkerRemoved: "FACT",
  // リソース・クールタイムイベント
  ResourceChanged: "FACT",
  ActionPointConsumed: "FACT",
  PassivePointConsumed: "FACT",
  ExtraGaugeIncreased: "FACT",
  ExtraGaugeConsumed: "FACT",
  ResourceCapacityChanged: "FACT",
  CooldownStarted: "FACT",
  CooldownReduced: "FACT",
  CooldownCompleted: "FACT",
  // RuntimeCounterイベント
  RuntimeCounterChanged: "FACT",
  RuntimeCounterReset: "FACT",
  // ユニットイベント
  CombatStatChanged: "FACT",
  UnitDefeated: "FACT",
  StunDurationChanged: "FACT",
  FreezeRemoved: "FACT",
};

/**
 * DIAGNOSTIC-category events are never valid `TriggerDefinition.eventType`
 * targets — `TriggerDefinition.category` only accepts `FACT`/`TIMING`
 * (`trigger-definition.ts`), so a Trigger can never legitimately match one of
 * these. Kept separate (not merged into `EVENT_TYPE_CATEGORIES`) so an
 * eventType lookup miss and a wrong-category-for-this-eventType are always
 * distinguishable failures.
 */
export const DIAGNOSTIC_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "EffectStepSkipped",
  "PassiveCandidateDetected",
  "PassiveCandidateSuppressed",
  "MemoryCandidateDetected",
  "MemoryCandidateSuppressed",
  "ExtraGaugeOverflowDiscarded",
]);
