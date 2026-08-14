import type { LogLevel } from "../simulation/simulate-battle-command.js";
import type {
  BattleDomainEvent,
  BattleDomainEventType,
} from "../../domain/battle/events/domain-event.js";

/**
 * `08_ドメインイベント.md`「公開レベル」のSUMMARY（「戦闘開始、行動結果、戦闘不能、
 * ターン終了、戦闘終了」）へ含めるかを、イベント種別ごとに明示する。
 *
 * `ReadonlySet`ではなく網羅レコードにしてあるのは、`BattleDomainEventType`へ
 * 新しい種別が加わったときにキー不足がコンパイルエラーになり、SUMMARYへ含めるかの
 * 判断を必ず通過させるため。除外を既定にすると新種別が黙ってSUMMARYから落ちる。
 */
export const SUMMARY_EVENT_TYPE_INCLUSION: Readonly<Record<BattleDomainEventType, boolean>> = {
  BattleStarted: true,
  TurnStarted: false,
  ResourcesRecovered: false,
  ActionQueueCreated: false,
  ActionReservationRemoved: false,
  ActionQueueReordered: false,
  ActionStarted: false,
  ActionWaited: false,
  TargetsSelected: false,
  SkillUseStarting: false,
  SkillUseStarted: false,
  SkillUseCompleted: false,
  EffectStepStarting: false,
  EffectStepSkipped: false,
  EffectStepCompleted: false,
  RandomBranchSelected: false,
  EffectActionStarting: false,
  EffectActionCompleted: false,
  UnitBeingAttacked: false,
  HitConfirmed: false,
  EvasionActivated: false,
  BlindnessCheckResolved: false,
  SkillMissed: false,
  CriticalCheckResolved: false,
  DamageWillBeApplied: false,
  DamageCalculated: false,
  ShieldConsumed: false,
  SubUnitDamaged: false,
  HitPointReduced: false,
  DamageApplied: false,
  DamageConvertedToHeal: false,
  LinkedDamageGenerated: false,
  DamageRedirected: false,
  ReflectedDamageGenerated: false,
  LethalDamageSurvived: false,
  HealApplied: false,
  HealingTransferred: false,
  ContinuousDamageApplied: false,
  EffectMerged: false,
  UnitDefeated: true,
  ActionCompleting: false,
  ActionCompleted: true,
  CooldownStarted: false,
  CooldownReduced: false,
  CooldownCompleted: false,
  ChargeStarted: false,
  ChargeReleased: false,
  ChargeReleaseCompleted: false,
  ChargeReleaseInterrupted: false,
  ChargeCancelled: false,
  ChargeHeldByFreeze: false,
  TurnCompleting: false,
  TurnCompleted: true,
  BattleCompleted: true,
  ResourceChanged: false,
  PassivePointConsumed: false,
  ExtraGaugeIncreased: false,
  ExtraGaugeOverflowDiscarded: false,
  PassiveActivated: false,
  PassiveResolved: false,
  PassiveInterrupted: false,
  MemoryTriggered: false,
  MemoryResolved: false,
  SkillUseInterrupted: false,
  RuntimeCounterChanged: false,
  RuntimeCounterReset: false,
  EffectApplied: false,
  EffectApplicationRejected: false,
  EffectiveEffectChanged: false,
  CombatStatChanged: false,
  ResourceCapacityChanged: false,
  EffectDurationReduced: false,
  StunDurationChanged: false,
  FreezeRemoved: false,
  EffectConsumptionChanged: false,
  EffectExpired: false,
  EffectRemoved: false,
  MarkerApplied: false,
  MarkerUpdated: false,
  MarkerRemoved: false,
  // R-TEX-02／`08_ドメインイベント.md`「公開レベル」: スコア加算は`DETAILED`から。
  ExerciseScoreAccumulated: false,
  // R-TEX-03／05: ブレイクと復活は`UnitDefeated`と同じく戦闘の骨格を成す事実なので
  // `SUMMARY`に含める（`08_ドメインイベント.md`「公開レベル」）。
  UnitBroken: true,
  UnitRevived: true,
};

/**
 * `09_アプリケーション設計.md`「SimulateBattleResult」: `events`は`logLevel`に
 * 応じて間引いた公開ログ、`stateTransitions`（状態復元に必要な差分）は
 * 公開レベルに関わらず全件保持する（この関数は`events`側だけを扱う）。
 *
 * `DETAILED`は全イベントを返し、`DIAGNOSTIC`はその非推奨の別名である
 * （`08_ドメインイベント.md`／`10_API設計.md`「公開レベル」）。2つのレベルの差は
 * `EffectStepSkipped`・`ExtraGaugeOverflowDiscarded`の2種だけであり、これを既定から
 * 隠すことは「効果が発動しなかった理由が既定のログに出ない」ことしか意味しないため、
 * `EventCategory`による絞り込みをやめて`DETAILED`へ統合した。`category`の
 * `DIAGNOSTIC`はイベントの性質を表す分類として残る。
 *
 * 間引かれたイベントを親に持つ子イベントは残る。公開`parentSequence`は間引き前の
 * 全件から解決するため（`battle-log-event.ts`の`toBattleLogEvents`）、
 * 「直接の原因イベントが公開されているかにかかわらず、元の連番を返す」
 * （`10_API設計.md`「BattleLogEventResponse」）が成立する。
 */
export function projectEventsForLogLevel(
  events: readonly BattleDomainEvent[],
  logLevel: LogLevel,
): readonly BattleDomainEvent[] {
  if (logLevel === "SUMMARY") {
    return events.filter((event) => SUMMARY_EVENT_TYPE_INCLUSION[event.eventType]);
  }
  return events;
}
