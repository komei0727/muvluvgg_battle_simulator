import {
  composeResourceGainRate,
  consumePp,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  requireUnit,
  type ResourceChangeRecordContext,
} from "./action-resolution-shared.js";
import { recordCooldownStart } from "./action-completion.js";
import {
  resolveEffectSequencePlan,
  type EffectActionGroupContext,
  type UnitsBox,
} from "./effect-action-group-resolver.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  emitEffectDurationReducedEvents,
  expireEffects,
  type ExpirationSeed,
} from "../effects/duration-expiry-service.js";
import {
  resolveBreakSteps,
  type BreakResolutionContext,
} from "../effects/break-resolution-service.js";
import type { BreakDeferral } from "../model/break-deferral.js";
import {
  decrementSkillUseEffectDurations,
  reapplySkillUseDurationDecrement,
} from "../model/applied-effect-duration.js";
import {
  collectPreAttackObservations,
  resolveMemoryEffectSequenceOrder,
  resolveSkillOrder,
} from "../skill/skill-resolution-service.js";
import { recordPreAttackObservation, shouldObserve } from "./pre-attack-observation-service.js";
import type { TriggerContext } from "../targeting/target-selection-policy.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { NO_MEMORIES, type BattleDefinitions } from "../model/battle-definitions.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { ResolutionResult } from "./resolution-result.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError, ExecutionGuardExceededError } from "../../shared/errors.js";
import { detectPassiveCandidates } from "../triggering/passive-trigger-matcher.js";
import {
  detectMemoryCandidates,
  matchesMemoryTrigger,
} from "../triggering/memory-trigger-matcher.js";
import type { MemoryCandidate } from "../triggering/memory-candidate.js";
import {
  applyMatchedRuntimeCounterUpdate,
  collectResolutionScopeResets,
  matchRuntimeCounterUpdates,
} from "../triggering/runtime-counter-matcher.js";
import type { ActiveEffectSequenceResolution } from "../triggering/effect-sequence-runtime-counter-matcher.js";
import {
  applyEffectRuntimeCounterUpdates as applyEffectRuntimeCounterUpdatesService,
  applyEffectSequenceRuntimeCounterUpdates as applyEffectSequenceRuntimeCounterUpdatesService,
  type RuntimeCounterUpdateContext,
} from "./runtime-counter-update-service.js";
import {
  applyExpirationConditions as applyExpirationConditionsService,
  applyExpirationConditionsForChain as applyExpirationConditionsForChainService,
  applyMarkerSourceDefeatRemovals as applyMarkerSourceDefeatRemovalsService,
  applyMarkerSourceDefeatRemovalsForChain as applyMarkerSourceDefeatRemovalsForChainService,
  type ChainExpirationDepthState,
  type ExpirationMarkerRemovalContext,
} from "./expiration-marker-removal-application-service.js";
import { resetRuntimeCounter } from "../model/runtime-counter-state.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import {
  createEmptyPassiveActivationGuard,
  type PassiveActivationGuard,
} from "../triggering/passive-activation-guard.js";
import type {
  PassiveChainLimits,
  PassiveChainLimitViolationReason,
} from "../model/passive-chain-limits.js";
import type { PassiveCandidate } from "../triggering/passive-candidate.js";
import {
  detectPassiveCandidateGroup,
  resolvePassiveChain,
  resolvePendingCandidateGroups,
  type PassiveActivation,
  type PassiveActivationStep,
  type PassiveChainDependencies,
} from "../triggering/resolve-passive-chain.js";
import type { PassiveResolutionStackEntry } from "../triggering/passive-resolution-stack.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";

/**
 * `finalizeResolutionScope`の「破棄→発行→候補解決」反復に対する上限。
 * counter更新は`PassiveActivationGuard`
 * （R-PS-07）を経由しないため、`DEFAULT_PASSIVE_CHAIN_LIMITS`だけでは
 * 自己再生成する`resetScope`counterの無限ループを検出できない。対象12行は
 * いずれも`resetScope`を宣言しないため通常は1周も要さず、この上限に
 * 到達すること自体が誤ったCatalog定義を示す。
 */
const MAX_RESOLUTION_SCOPE_RESET_ROUNDS = 10;

/**
 * `onFactEvent`が自身の`RuntimeCounterChanged`を再帰的に候補解決へ回す深さの上限
 * （M6完了条件「実行ガードがPS深度とイベント数を監視する」）。
 * `RuntimeCounterChanged`を自身の`counterUpdates.trigger`に
 * 持つCatalog定義は、更新→発行→候補解決の都度また同じcounterを更新しうるため、
 * この再帰は`PassiveChainLimits`（1解決スコープ単位のPS深度・効果解決数）にも
 * `EventRecorder`の総イベント数Guardにも到達する前にJSの呼び出しスタックを
 * 使い尽くしうる。決定的な`ExecutionGuardExceededError`として早期に検出する。
 * `onFactEvent`の再帰（`SKILL_RUNTIME`スコープ・トップレベルの`AppliedEffect`
 * スコープ）専用のカウンタで、`resolveEvent`自身の再帰を守る
 * `PassiveChainLimits.maxEffectRuntimeCounterDepth`（PS連鎖内部の`AppliedEffect`
 * スコープ）とは別の経路だが、上限値そのものは同じ
 * `maxEffectRuntimeCounterDepth`を共有する（`11_インフラストラクチャ設計.md`
 * 「SimulationExecutionGuard」が「両スコープで共有」と定める1つのつまみ）。
 * この定数はその既定値であり、上限判定自体は`this.limits`（設定で上書き可能）
 * を読む。
 */
const MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH = 10;

/**
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の既定値。
 * 運用値は`SIMULATION_MAX_PASSIVE_DEPTH`等の環境変数から
 * `BattleDefinitions.executionLimits`経由で上書きでき、この定数は上書きが
 * 無い場合（テスト・CLI・既定構成）に使われる。
 */
export const DEFAULT_PASSIVE_CHAIN_LIMITS: PassiveChainLimits = {
  maxPassiveDepth: 8,
  /**
   * REL-005（Issue #198）の実測（`LOAD-CAPACITY-002`）で、production Catalogの
   * 5対5・99ターン・DETAILEDの全29編成（ミラー14・混成15）を走査すると、
   * 1解決スコープあたり最大54件の効果解決を必要とする。旧値50はこれを**下回って
   * おり**、正常な混成編成が`EXECUTION_LIMIT_EXCEEDED`（503）で落ちていた
   * （暴走した定義ではなく、対象数の多いEffectSequenceが正しく解決された結果）。
   * 実測値の約1.9倍へ引き上げる（`maxPassiveDepth`は実測4に対し8で2倍の余裕が
   * あるため据え置き）。
   */
  maxEffectsPerScope: 100,
  maxEffectRuntimeCounterDepth: MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH,
};

/** `PassiveActivationRuntime`が1解決スコープ分の発動処理を行うために必要な依存。 */
export interface PassiveActivationRuntimeContext {
  readonly definitions: BattleDefinitions;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 行動外のトップレベルイベント（ターン開始・終了など）から発動する場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly limits?: PassiveChainLimits;
  /**
   * R-TEX-02: Battleが所有する演習状態。PS/Memoryの連鎖が与えるダメージも
   * 同じ規則で計上するため、解決する`EffectActionGroupContext`へそのまま渡す。
   */
  readonly exercise?: ExerciseRuntime;
  /**
   * `RESOLUTION_PHASE`（TRIGGER_EXCLUSION_TIMING）が参照する、この
   * 解決スコープのroot事象が属するBattle/Turn phase。呼び出し側（`battle.ts`の
   * `TurnStarted`/`TurnCompleting`呼び出し等）が1解決スコープにつき1回だけ決める。
   * 行動中の解決スコープでは`undefined`（既定値、いずれの`phase`とも一致しない）。
   */
  readonly resolutionPhase?: ResolutionPhase;
}

function toResourceChangeContext(
  context: PassiveActivationRuntimeContext,
  skillUseId?: SkillUseId,
): ResourceChangeRecordContext {
  return {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    resolutionScopeId: context.resolutionScopeId,
    rootEventId: context.rootEventId,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(skillUseId !== undefined ? { skillUseId } : {}),
  };
}

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」の発動処理側（#34/#73が実装する
 * `ActivatePassiveCandidate`）。1解決スコープ（1行動、またはターン開始・終了
 * などの行動外トップレベルイベント）ごとに1つ生成し、`onFactEvent`をそのスコープ
 * 内で起きるFACT/TIMINGイベントの都度呼び出す。R-PS-07（1解決スコープ1回制限、
 * `guard`）と、それに乗る`units`の最新状態をこのインスタンスが保持する。
 *
 * R-SKL-06（ACTION step内の1EffectAction単位での即時PS解決、PS発動条件・対象・
 * action定義順の完成）は#73のスコープ。本実装は`resolveSkillOrder`が計画した
 * PSのEffectSequence全体を`applyEffectActionGroups`で一括適用し、そこから
 * 発生したイベントを`resolvePassiveChain`へ一度にyieldする（R-PS-06の入れ子
 * 解決自体は`resolvePassiveChain`（#21）の既存機構でそのまま働く。#73は
 * このyield粒度を1EffectAction単位まで細かくする）。
 */
export class PassiveActivationRuntime {
  private readonly context: PassiveActivationRuntimeContext;
  private units: readonly BattleUnit[];
  private guard: PassiveActivationGuard;
  private readonly recordedEventIdOf = new Map<TriggerCandidateEvent, DomainEventId>();
  /**
   * R-EFF-08の自己再誘発（`applyExpirationConditionsForChain`が発行した
   * `EffectExpired`/`CombatStatChanged`がさらに別の`expiration.conditions`を
   * 成立させ続ける）を検出する再帰深度。`RuntimeCounterChanged`の再帰とは
   * 独立した別の自己再誘発経路のため、専用のカウンタで管理する（上限値は
   * 同じ`maxEffectRuntimeCounterDepth`を共有する）。`applyMarkerSourceDefeatRemovalsForChain`
   * と共有する可変の保持先のため、`./expiration-marker-removal-application-service.js`
   * が定義する`ChainExpirationDepthState`をそのまま使う。
   */
  private readonly chainExpirationDepth: ChainExpirationDepthState = { depth: 0 };
  /**
   * `applyEffectRuntimeCounterUpdates`は`onFactEvent`の
   * トップレベル呼び出し（`event`自身の状態変更を確定させ、原因となった
   * `RuntimeCounterChanged`を`onFactEvent`へ再帰させ`SkillRuntime`counter検出
   * 等を含む完全な扱いを与えるため）と、`resolvePassiveChain`へ注入する
   * `deps.applyEffectRuntimeCounterUpdates`（PS連鎖内部の`TIMING_EVENT`/
   * `EFFECT_RESOLVED`イベントを届けるため）の両方から呼ばれる。
   * `resolvePassiveChain`の最初の`resolveEvent(initialEvent, ...)`呼び出しは
   * `onFactEvent`が渡す同じトップレベル`event`（`TriggerCandidateEvent`化した
   * もの）を再び処理するため、同じ`DomainEventId`を二重に処理しないよう
   * 一度処理した`DomainEventId`を記録する（`R-EFF-08`の`applyExpirationConditions`
   * が「units変異後は対象が見つからずno-opになる」自然な冪等性で二重発行を
   * 避けるのと異なり、counter加算は同じeventに対して毎回マッチしうるため
   * 明示的なガードが必要）。自己再誘発の再帰深度は、PS連鎖内部の経路については
   * `resolvePassiveChain`側の`ChainState.effectRuntimeCounterDepth`
   * （`resolve-passive-chain.ts`）が、トップレベルの経路については
   * `onFactEvent`自身の`counterUpdateDepth`が、それぞれ独立に管理する
   * （このクラス側に単一のインスタンスフィールドを持たせると、
   * `resolveChild`による再帰的候補解決を待たずに呼び出しごとへリセットされ、
   * 上限が機能しない）。
   */
  private readonly processedEffectRuntimeCounterEventIds = new Set<DomainEventId>();
  /**
   * `applyEffectRuntimeCounterUpdates`が発行する
   * `RuntimeCounterChanged`へ、原因イベントが属するPSのSkillUseへ関連付けるための
   * `skillUseId`を伝播するための逆引きmap。`toTriggerEvent`（原因イベントを
   * `TriggerCandidateEvent`化するたび）に、元の`BattleDomainEvent.skillUseId`を
   * 記録する。「同じSkillUse解決に属するイベントは同じ`skillUseId`を持つ」
   * （`08_ドメインイベント.md`）を`AppliedEffect`スコープのcounter更新でも
   * 満たすため。
   */
  private readonly skillUseIdOf = new Map<DomainEventId, SkillUseId>();
  /**
   * EFF-006: `R-EFF-11`の`EffectSequence`スコープ。`EffectSequence`
   * 自身は状態を持たないため、`applyEffectSequenceRuntimeCounterUpdates`が
   * `units`だけからcounterUpdates定義を再発見できない（`AppliedEffect`の
   * `units[].appliedEffects[]`、`SkillRuntime`の`SkillDefinition.counterUpdates`
   * と異なる）。呼び出し側（`action-skill-use-resolver.ts`／
   * `action-charge-resolver.ts`／`activatePassiveCandidate`自身）が
   * `beginEffectSequenceResolution`で1回の解決の開始を登録し、
   * `finalizeEffectSequenceResolution`（またはPS連鎖内部用のgenerator版）で
   * その終了時にこのMapからエントリ自体を削除する。
   */
  private readonly activeEffectSequenceResolutions = new Map<
    SkillUseId,
    ActiveEffectSequenceResolution
  >();
  /**
   * `processedEffectRuntimeCounterEventIds`と同じ理由の別スコープ用ガード
   * （`AppliedEffect`と`EffectSequence`は別々のマッチング対象を持つため、
   * 同じeventIdでも独立に二重処理を防ぐ必要がある）。
   */
  private readonly processedEffectSequenceRuntimeCounterEventIds = new Set<DomainEventId>();
  /**
   * R-SKL-08: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
   * が参照する「同じ解決スコープ内の直前DAMAGE結果」。このクラス自体が
   * 「1解決スコープ（=1行動、または行動外トップレベルイベント）につき1つだけ
   * 生成される」契約（コンストラクタのコメント、R-PS-07と同じ境界）を持つため、
   * インスタンスフィールドとして持てばスコープ境界と寿命が自然に一致する —
   * 明示的な破棄処理は不要（このインスタンス自体がGCされれば消える）。
   * `getUnitLastDamageResults`経由でPS連鎖内の`groupContext`（このクラス自身が
   * 構築）と、呼び出し元（`action-skill-use-resolver.ts`/`action-charge-resolver.ts`が
   * 構築する、この行動自身のEffectSequence用`EffectActionGroupContext`）の
   * 両方が同じインスタンスを共有する。
   */
  private readonly damageResults: DamageResultRegistry = new Map();
  /**
   * `R-ATM-01`の保留キュー（トップレベルの効果処理フェーズ用）。AS/EX使用・
   * チャージ解放は`applyEffectActionGroups`が同期callback（`onFactEventForPassiveChain`
   * →`onFactEvent`）でイベントを届けるため、`resolvePassiveChain`のジェネレータ
   * 駆動（PS/Memory自身の解決）とは別にこちら側でフレームを持つ。
   * `beginEffectProcessingPhase`で1つ積み、`drainEffectProcessingPhase`で取り出す。
   * 配列にしているのは対称な呼び出しをネストしても壊れないようにするためで、
   * 実際の運用では深さ1しか使わない。
   */
  private readonly pendingEffectProcessingFrames: PassiveResolutionStackEntry[][] = [];

  /**
   * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」「上限値は設定から
   * 受け取る」の解決順。呼び出し側が明示した`context.limits`（PS連鎖の単体テストが
   * 極小値を注入する経路）を最優先し、次に戦闘単位の運用設定
   * （`BattleDefinitions.executionLimits`、`SIMULATION_MAX_*`由来）、最後に既定値。
   */
  private readonly limits: PassiveChainLimits;

  constructor(context: PassiveActivationRuntimeContext, initialUnits: readonly BattleUnit[]) {
    this.context = context;
    this.units = initialUnits;
    this.guard = createEmptyPassiveActivationGuard();
    this.limits =
      context.limits ?? context.definitions.executionLimits ?? DEFAULT_PASSIVE_CHAIN_LIMITS;
  }

  /** `action-skill-use-resolver.ts`/`action-charge-resolver.ts`が自身のEffectSequenceへも同じregistryを渡すための公開アクセサ。 */
  get damageResultsRegistry(): DamageResultRegistry {
    return this.damageResults;
  }

  get currentUnits(): readonly BattleUnit[] {
    return this.units;
  }

  /**
   * EFF-006: 呼び出し側（`action-skill-use-resolver.ts`のAS/EX、
   * `action-charge-resolver.ts`のチャージ解放、この行動専用`activatePassiveCandidate`
   * のPS自身のEffectSequence）が、これから解決する1つのEffectSequenceが宣言する
   * `counterUpdates`（あれば）を登録する。`skillUseId`はその解決を一意に識別する
   * 既存の実行時識別子であり、`EFFECT_SEQUENCE`スコープのcounterの保持先キーにも
   * そのまま使う。`counterUpdates`が空配列でも登録して構わない（マッチ対象が
   * 無いだけで、`finalizeEffectSequenceResolution`の呼び出しは省略できない —
   * 呼び出し側は毎回対で呼ぶ契約にした方が単純なため）。
   */
  beginEffectSequenceResolution(
    skillUseId: SkillUseId,
    actorUnitId: BattleUnitId,
    skillDefinitionId: SkillDefinitionId,
    counterUpdates: readonly RuntimeCounterUpdateDefinition[],
  ): void {
    this.activeEffectSequenceResolutions.set(skillUseId, {
      actorUnitId,
      skillDefinitionId,
      counterUpdates,
    });
  }

  /**
   * `R-ATM-02` #2「効果処理フェーズ」の開始。以降`drainEffectProcessingPhase`までの
   * 間に`onFactEvent`へ届いたFACTイベントは、状態保守だけを即時に確定させ、PS/Memory
   * 候補の**発動**を保留する（`R-ATM-01`）。TIMINGイベント（`EffectStepStarting`・
   * `EffectActionStarting`・`UnitBeingAttacked`・`DamageWillBeApplied`）は保留の
   * 対象外で従来どおり即時解決する — 効果処理中のTIMINGイベントを発動契機から
   * 外すのは`R-ATM-04`の担当であり、本メソッドの責務ではない。
   *
   * 呼び出し側（AS/EX使用・チャージ解放）は`applyEffectActionGroups`の直前に呼び、
   * 完了イベント（`SkillUseCompleted`等）を`onFactEvent`へ渡した直後に
   * `drainEffectProcessingPhase`を必ず対で呼ぶ。
   */
  beginEffectProcessingPhase(): void {
    this.pendingEffectProcessingFrames.push([]);
    // R-TEX-03 #5: ブレイク保留フレームは`R-ATM-01`の保留キューと同じ寿命・同じ
    // 入れ子を持つ（`05_ドメインモデル.md`「BreakResolutionService」）ため、同じ位置で
    // 開く。閉じるのは`drainEffectProcessingPhase`ではなく`resolveDeferredBreak`
    // である — 解決は完了イベントの**発行前**であり、保留キューの排出（後段フェーズ、
    // 完了イベントの発行後）より早いためである（R-TEX-06 #5）。
    this.breakDeferral?.beginEffectProcessing();
  }

  /** R-TEX-03 #5の保留先。演習でなければ保留窓そのものが存在しない。 */
  private get breakDeferral(): BreakDeferral | undefined {
    return this.context.exercise?.deferredBreaks;
  }

  /**
   * R-TEX-06 #5: 効果処理フェーズの末尾（全stepの解決後・追撃の解決後・完了イベントの
   * 発行前）で、保留したブレイクを解決する。トップレベルの効果処理（AS/EX使用・
   * チャージ解放）専用の入口で、`beginEffectProcessingPhase`と対で呼ぶ。
   *
   * R-TEX-06 #6: ここで発行するイベント（`UnitBroken`・解除の`EffectRemoved`／
   * `MarkerRemoved`・`UnitRevived`・強化の`CombatStatChanged`）は`onFactEvent`へ渡す。
   * 効果処理フェーズはまだ開いているため、それらのPS/Memory候補は`R-ATM-01`の保留
   * キューへ積まれ、完了イベント自身の候補より前に後段フェーズで発動する。
   *
   * R-TEX-06 #7: 中断した効果処理でも呼ぶ — 発生済みの事実を中断は消さない。
   */
  resolveDeferredBreak(
    skillUseId: SkillUseId,
    cursor: DomainEventId,
    units?: readonly BattleUnit[],
  ): ResolutionResult {
    if (units !== undefined) {
      this.units = units;
    }
    const pending = this.breakDeferral?.endEffectProcessing();
    const exercise = this.context.exercise;
    if (pending === undefined || exercise === undefined) {
      return { units: this.units, lastEventId: cursor };
    }
    const steps = resolveBreakSteps(
      this.breakResolutionContext(exercise, skillUseId),
      this.units,
      pending.targetUnitId,
      this.context.definitions.effectActions,
      pending.causeEventId,
      pending.defeatSource,
    );
    let step = steps.next();
    while (!step.done) {
      this.units = step.value.units;
      for (const recorded of step.value.events) {
        this.units = this.onFactEvent(recorded, this.units).units;
      }
      step = steps.next(this.units);
    }
    this.units = step.value.units;
    return { units: this.units, lastEventId: step.value.lastEventId };
  }

  /**
   * `resolveDeferredBreak`のPS/Memory自身のEffectSequence版。generator駆動の経路
   * であるため、各stepのイベントを`DEFERRED_EVENT`として`yield`し、進行中の
   * `driveSteps`の保留キューへ参加させる（`R-ATM-01`）。
   *
   * `this.onFactEvent`を再帰させてはならない — 新しい`resolvePassiveChain`を起こして
   * 進行中の連鎖のguard/stackを上書きしてしまう（`applyMarkerSourceDefeatRemovalsForChain`
   * と同じ制約）。`EFFECT_RESOLVED`ではなく`DEFERRED_EVENT`を使うのは、ブレイク解決が
   * 効果解決数Guardの数える「実際に解決した効果」ではなく効果処理フェーズ境界の処理で
   * あり、同じ位置の`EffectSequence`スコープ`RuntimeCounterReset`と同じ扱いになる
   * ためである。
   */
  private *resolveDeferredBreakSteps(
    skillUseId: SkillUseId,
    cursor: DomainEventId,
  ): Generator<PassiveActivationStep, DomainEventId, unknown> {
    const pending = this.breakDeferral?.endEffectProcessing();
    const exercise = this.context.exercise;
    if (pending === undefined || exercise === undefined) {
      return cursor;
    }
    const steps = resolveBreakSteps(
      this.breakResolutionContext(exercise, skillUseId),
      this.units,
      pending.targetUnitId,
      this.context.definitions.effectActions,
      pending.causeEventId,
      pending.defeatSource,
    );
    let step = steps.next();
    while (!step.done) {
      this.units = step.value.units;
      for (const recorded of step.value.events) {
        yield { kind: "DEFERRED_EVENT", event: this.toTriggerEvent(recorded) };
      }
      step = steps.next(this.units);
    }
    this.units = step.value.units;
    return step.value.lastEventId;
  }

  /**
   * `resolveBreakSteps`が要求する因果関係コンテキスト。`onFactEventForPassiveChain`は
   * 渡さない — 両方の呼び出し側が自分でstepを駆動し、それぞれの経路に合った方法
   * （トップレベルは`onFactEvent`、PS連鎖内部は`DEFERRED_EVENT`のyield）で候補へ
   * 届けるためである。
   */
  private breakResolutionContext(
    exercise: ExerciseRuntime,
    /**
     * HP0へ到達した効果処理の`SkillUseId`。解決位置がフェーズ末尾へ移っても、
     * ブレイク解決が発行するイベントはその効果処理に属する（`08_ドメインイベント.md`
     * 「同じSkillUseIdに属するイベント」）ため、到達時点と同じ`skillUseId`を載せる。
     */
    skillUseId: SkillUseId,
  ): BreakResolutionContext {
    return {
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      resolutionScopeId: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
      exercise,
    };
  }

  /**
   * `R-ATM-02` #3「後段フェーズ」: 直前の効果処理フェーズで保留した候補グループを
   * イベント発生順に発動させる。完了イベント自身の候補はキューの末尾に積まれている
   * ため、保留分をすべて解決した後に発動する（`R-ATM-01`の即時解決規則の唯一の例外）。
   *
   * 中断（使用者戦闘不能）で終わった効果処理でも呼ぶ — 「発生済みイベントへの反応を
   * 中断が消すことはない」（`R-ATM-02`）。
   *
   * 戻り値は`onFactEvent`と同じ`ResolutionResult`。この呼び出し自身が何も発行
   * しなければ（保留候補が無い、または全て`R-PS-04`で破棄された場合）、受け取った
   * `cursor`をそのまま`lastEventId`として返す。
   */
  drainEffectProcessingPhase(
    cursor: DomainEventId,
    units?: readonly BattleUnit[],
  ): ResolutionResult {
    if (units !== undefined) {
      this.units = units;
    }
    const frame = this.pendingEffectProcessingFrames.pop();
    if (frame === undefined || frame.length === 0) {
      return { units: this.units, lastEventId: cursor };
    }
    const eventsStart = this.context.recorder.getEvents().length;
    // フレームは既に取り外してあるため、この解決中に発動したPS/Memoryが
    // `onFactEvent`を経由することがあっても親のキューへ積まれることはない
    // （それぞれの発動は`resolvePassiveChain`側の自分のフレームを持つ）。
    // キューは1回の呼び出しでまとめて渡す — グループごとに解決を分けると
    // 効果解決数Guardがグループ単位でリセットされ、各グループが上限未満でも
    // 合計が上限を超える連鎖を検出できなくなる（`R-ATM-02`「実行ガードは
    // 従来どおり1解決スコープ単位で数える」）。
    const result = resolvePendingCandidateGroups(frame, this.guard, this.buildDependencies());
    if (!result.ok) {
      throw new ExecutionGuardExceededError(
        `PS chain resolution exceeded its execution guard: ${result.reason}`,
      );
    }
    this.guard = result.activationGuard;
    const recordedEvents = this.context.recorder.getEvents();
    const last =
      recordedEvents.length > eventsStart ? recordedEvents[recordedEvents.length - 1] : undefined;
    return { units: this.units, lastEventId: last?.eventId ?? cursor };
  }

  /**
   * `R-ATM-01`: 効果処理フェーズが進行中で、かつ`event`がFACTイベントであれば
   * 発動を保留する。`DIAGNOSTIC`は`toTriggerEvent`がFACTとして扱う分類のため
   * 同じく保留対象とする。
   */
  private defersActivationOf(event: BattleDomainEvent): boolean {
    return this.pendingEffectProcessingFrames.length > 0 && event.category !== "TIMING";
  }

  private toTriggerEvent(event: BattleDomainEvent): TriggerCandidateEvent {
    const triggerEvent: TriggerCandidateEvent = {
      eventType: event.eventType,
      category: event.category === "DIAGNOSTIC" ? "FACT" : event.category,
      ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
      ...(event.sourceSide !== undefined ? { sourceSide: event.sourceSide } : {}),
      ...(event.targetUnitIds !== undefined ? { targetUnitIds: event.targetUnitIds } : {}),
      payload: event.payload,
    };
    this.recordedEventIdOf.set(triggerEvent, event.eventId);
    if (event.skillUseId !== undefined) {
      this.skillUseIdOf.set(event.eventId, event.skillUseId);
    }
    return triggerEvent;
  }

  private eventIdOf(event: TriggerCandidateEvent): DomainEventId {
    const eventId = this.recordedEventIdOf.get(event);
    if (eventId === undefined) {
      throw new DomainValidationError(
        "event",
        "TriggerCandidateEvent was not produced by this PassiveActivationRuntime (its DomainEventId is unknown)",
      );
    }
    return eventId;
  }

  /**
   * `event`（原因イベント）が属するPSのSkillUseへ
   * `RuntimeCounterChanged`を関連付けるための`skillUseId`。原因イベント自身が
   * `skillUseId`を持たない場合（ターン開始・終了等の行動外トップレベル
   * イベント）は`undefined`。
   */
  private skillUseIdOfCausingEvent(event: TriggerCandidateEvent): SkillUseId | undefined {
    return this.skillUseIdOf.get(this.eventIdOf(event));
  }

  private buildDependencies(): PassiveChainDependencies {
    return {
      detectCandidates: (event) =>
        detectPassiveCandidates({
          event,
          units: this.units,
          unitDefinitions: this.context.definitions.unitDefinitions,
          skillDefinitions: this.context.definitions.skillDefinitions,
          activationGuard: this.guard,
          turnNumber: this.context.turnNumber,
          ...(this.context.resolutionPhase !== undefined
            ? { resolutionPhase: this.context.resolutionPhase }
            : {}),
        }),
      getCurrentUnit: (battleUnitId) => requireUnit(this.units, battleUnitId),
      // `getCurrentUnit`（`requireUnit`）は未知のBattleUnitIdに
      // 例外を送出するため、POSITION_RELATIONの対象不在を条件不成立として決定的に
      // 扱うR-PS-01の契約には使えない。対象解決専用に、見つからない
      // 場合`undefined`を返す`findUnit`を分けて渡す。
      findUnit: (battleUnitId) => this.units.find((unit) => unit.battleUnitId === battleUnitId),
      activate: (candidate, event): PassiveActivation =>
        this.activatePassiveCandidate(candidate, event),
      // R-MEM-01/02（M7-006）: 同じイベントのMemory候補。PS候補と同じ
      // `resolvePassiveChain`のスタックへ乗せ、PS候補を使い切った後に解決させる。
      detectMemoryCandidates: (event) =>
        detectMemoryCandidates({
          event,
          units: this.units,
          memoriesBySide: this.context.definitions.memoriesBySide ?? NO_MEMORIES,
          ...(this.context.resolutionPhase !== undefined
            ? { resolutionPhase: this.context.resolutionPhase }
            : {}),
          turnNumber: this.context.turnNumber,
        }),
      reconfirmMemoryCandidate: (candidate, event) =>
        this.reconfirmMemoryCandidate(candidate, event),
      activateMemory: (candidate, event): PassiveActivation =>
        this.activateMemoryCandidate(candidate, event),
      limits: this.limits,
      turnNumber: this.context.turnNumber,
      // RES-004: `ALIVE_UNIT_COUNT`の再確認（R-PS-04）が候補検出時と
      // 同じ生存数母集団を使うため、`findUnit`と同様に`this.units`を都度読み直す
      // 関数として渡す（PS連鎖の途中で`this.units`が変わりうるため固定配列は使えない）。
      getAllUnits: () => this.units,
      // M7-001E: `TARGET_STATE`の`UNIT_TYPE`/`ROLE`（`SKL_CHIYURU_MAZE_PS2`／
      // `SKL_LUCIE_MAID_PS1`のtrigger条件）を、再確認（R-PS-04）でも候補検出時と
      // 同じCatalog参照表で評価する。
      unitDefinitions: this.context.definitions.unitDefinitions,
      ...(this.context.resolutionPhase !== undefined
        ? { resolutionPhase: this.context.resolutionPhase }
        : {}),
      applyExpirationConditions: (event) => this.applyExpirationConditionsForChain(event),
      // M7-020: R-EFF-08と同じく「関連するドメインイベント発行後、
      // PS/Memory候補の抽出前」に評価する独立した機構。`resolveEvent`側では
      // `applyExpirationConditions`の直後に呼ばれる（トップレベルの`onFactEvent`と
      // 同じ順序）。イベント配列を返す形ではなく`resolveChild`形をとる
      // （R-EFF-09の逐次通知契約を満たすため）。
      applyMarkerSourceDefeatRemovals: (event, resolveChild) =>
        this.applyMarkerSourceDefeatRemovalsForChain(event, resolveChild),
      applyEffectRuntimeCounterUpdates: (event, resolveChild) =>
        this.applyEffectRuntimeCounterUpdates(event, (recorded) =>
          resolveChild(this.toTriggerEvent(recorded)),
        ),
      applyEffectSequenceRuntimeCounterUpdates: (event, resolveChild) =>
        this.applyEffectSequenceRuntimeCounterUpdates(event, (recorded) =>
          resolveChild(this.toTriggerEvent(recorded)),
        ),
    };
  }

  /**
   * `08_ドメインイベント.md`「イベント発行と処理」#3（M6最小実装）:
   * 原因イベントに起因する`RuntimeCounter`更新（`counterUpdates`、`SKILL_RUNTIME`
   * スコープ）を検出し、`RuntimeCounterChanged`を発行する。発行したイベントの
   * 候補解決は呼び出し側の責務とする（`state.guard`/stackを共有できるかどうかは
   * 呼び出し元のコンテキストに依存するため、ここではguardに触れない）。
   *
   * 同一原因
   * イベントで複数counterが変化する場合、「units反映→record→(呼び出し側の)
   * 候補解決」を1件ずつ行うため、このメソッドをgeneratorにし、1件`record`
   * するたびに`yield`して呼び出し側へ制御を返す。呼び出し側（`onFactEvent`の
   * 再帰呼び出し／`activatePassiveCandidate`の`TIMING_EVENT`）が`for...of`で
   * その候補解決を終えてから次の`.next()`を呼ぶため、後続counterの
   * `this.units`反映は先行するcounterの候補解決が完了した後になる。
   *
   * マッチする`counterUpdates`定義の集合と順序（`matchRuntimeCounterUpdates`）は
   * 原因イベント直後の`this.units`から一度だけ確定し、以降のPS連鎖による状態
   * 変化でこの集合を再評価（追加・除外）しない（R-EFF-11「原因イベントの状態
   * 変更確定後、PS/Memory候補抽出前にcounter更新を決定する」）。同じcounterを
   * 更新する複数定義も、配列上の別エントリとして区別されるため両方適用される
   * （processed済み判定によって2件目以降が失われない）。各エントリの
   * `before`/`after`/`carry`だけは`applyMatchedRuntimeCounterUpdate`が適用時点の
   * `this.units`（＝直前の候補解決後の最新状態）から計算し直す — マッチング
   * 確定時の値をそのまま使うと、先行counterの候補解決（PS連鎖）がまだ処理して
   * いない後続counterの変更を古い値で上書きしてしまう（修正前の不具合）。
   */
  private *detectAndRecordRuntimeCounterChanges(
    causingEvent: BattleDomainEvent,
    skillUseId?: SkillUseId,
  ): Generator<BattleDomainEvent, void, unknown> {
    const triggerEvent = this.toTriggerEvent(causingEvent);
    const matched = matchRuntimeCounterUpdates({
      event: triggerEvent,
      units: this.units,
      unitDefinitions: this.context.definitions.unitDefinitions,
      skillDefinitions: this.context.definitions.skillDefinitions,
    });
    for (const entry of matched) {
      const result = applyMatchedRuntimeCounterUpdate(entry, this.units, triggerEvent);
      this.units = result.units;
      const change = result.change;
      if (change === undefined) {
        continue;
      }

      const carryChanged = change.carry !== change.carryBefore;
      const recorded = this.context.recorder.record({
        eventType: "RuntimeCounterChanged",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        ...(skillUseId !== undefined ? { skillUseId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: causingEvent.eventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: change.ownerUnitId,
        payload: {
          ownerUnitId: change.ownerUnitId,
          scope: "SKILL_RUNTIME",
          counter: change.counter,
          skillDefinitionId: change.skillDefinitionId,
          before: change.before,
          after: change.after,
          carry: change.carry,
          // `value`が変化していない（carryのみの
          // 変化の）更新でもこのイベント自体は発行する（追跡性のため）ので、
          // 閾値到達時だけ発動すべきPSはこのフィールドで絞り込む契約とする。
          valueChanged: change.valueChanged,
        },
        stateDelta: {
          units: {
            [change.ownerUnitId]: {
              // `value`(公開値)が変化した場合だけ
              // `skillCounters`を持つ。carryのみの変化では公開値のstateDeltaを
              // 持たせない（「変更した項目だけを持つ」契約、carryは
              // `skillCounterCarry`側に独立して持つ）。
              ...(change.valueChanged
                ? {
                    skillCounters: {
                      [change.skillDefinitionId]: {
                        [change.counter]: { before: change.before, after: change.after },
                      },
                    },
                  }
                : {}),
              ...(carryChanged
                ? {
                    skillCounterCarry: {
                      [change.skillDefinitionId]: {
                        // `captureBattleState`は
                        // carryが0のcounterをキーごと省略するため（`0`は
                        // デフォルト値扱い）、carryがちょうど0へ戻った場合も
                        // `after: 0`ではなく`undefined`（キー削除）にして
                        // 独立Reducerの復元結果を実状態と一致させる。
                        [change.counter]: {
                          before: change.carryBefore,
                          after: change.carry === 0 ? undefined : change.carry,
                        },
                      },
                    },
                  }
                : {}),
            },
          },
        },
      });
      yield recorded;
    }
  }

  /**
   * `applyEffectRuntimeCounterUpdates`/`applyEffectSequenceRuntimeCounterUpdates`
   * （`./runtime-counter-update-service.js`、EFF-005/EFF-006）へ渡す共通
   * envelope。`getUnits`/`setUnits`は`this.units`への読み書きを外側から行う
   * アクセサ — `resolveChild`（呼び出し元の候補解決）が`this.units`へ及ぼす
   * 副作用を、同じ呼び出し内の後続エントリが読み直せるようにする
   * （`buildDependencies()`の他アクセサと同じ理由）。
   */
  private runtimeCounterUpdateContext(): RuntimeCounterUpdateContext {
    return {
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      resolutionScopeId: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
      getUnits: () => this.units,
      setUnits: (units) => {
        this.units = units;
      },
    };
  }

  /**
   * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-005。`onFactEvent`専用から
   * `resolvePassiveChain`共通経路へ拡張）: `SkillRuntime`スコープの
   * `detectAndRecordRuntimeCounterChanges`の`AppliedEffect`スコープ版。実装・
   * 詳細な理由は`./runtime-counter-update-service.js`（REF-063 #1）へ抽出した。
   */
  private applyEffectRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined {
    return applyEffectRuntimeCounterUpdatesService(
      this.runtimeCounterUpdateContext(),
      this.processedEffectRuntimeCounterEventIds,
      event,
      this.eventIdOf(event),
      this.skillUseIdOfCausingEvent(event),
      resolveChild,
    );
  }

  /**
   * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-006）:
   * `applyEffectRuntimeCounterUpdates`（`AppliedEffect`スコープ）の
   * `EffectSequence`スコープ版。実装・詳細な理由は`./runtime-counter-update-service.js`
   * （REF-063 #1）へ抽出した。`this.activeEffectSequenceResolutions`の登録・削除
   * （`beginEffectSequenceResolution`／`finalizeEffectSequenceResolution(Steps)`）
   * はこのクラス側の責務のまま残す — 抽出先は読み取り専用でこのMapを参照する。
   */
  private applyEffectSequenceRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined {
    return applyEffectSequenceRuntimeCounterUpdatesService(
      this.runtimeCounterUpdateContext(),
      this.processedEffectSequenceRuntimeCounterEventIds,
      this.activeEffectSequenceResolutions,
      event,
      this.eventIdOf(event),
      resolveChild,
    );
  }

  /**
   * EFF-006: `EffectSequence`は状態を持たないため、1回の解決が
   * 完了した時点で必ずそのcounterを破棄する（`SkillRuntime`の
   * `resetScope: "RESOLUTION_SCOPE"`と異なり、宣言による選択の余地がない）。
   * `this.activeEffectSequenceResolutions`からエントリ自体を先に削除してから
   * 破棄・`RuntimeCounterReset`発行を行う — この順序により、`RuntimeCounterReset`
   * 自身を再誘発契機にする誤ったCatalog定義（`R-EFF-11`が警告する自己再生成
   * パターン）があっても、削除済みの解決に対しては`applyEffectSequenceRuntimeCounterUpdates`
   * が何もマッチさせられないため、無限ループが原理的に起こらない
   * （`finalizeResolutionScope`の反復回数上限とは異なる安全策）。
   * `resolveChild`が呼ばれる前に`this.units`へ書き込む点、複数counterを1件ずつ
   * 発行・解決する点は既存パターンと同じ。
   */
  private *finalizeEffectSequenceResolutionSteps(
    skillUseId: SkillUseId,
  ): Generator<BattleDomainEvent, void, void> {
    const resolution = this.activeEffectSequenceResolutions.get(skillUseId);
    this.activeEffectSequenceResolutions.delete(skillUseId);
    if (resolution === undefined) {
      return;
    }
    const actor = requireUnit(this.units, resolution.actorUnitId);
    const counters = actor.effectSequenceCounters?.[skillUseId] ?? {};
    for (const counterId of Object.keys(counters) as (keyof typeof counters)[]) {
      const currentActor = requireUnit(this.units, resolution.actorUnitId);
      const currentCounters = currentActor.effectSequenceCounters?.[skillUseId] ?? {};
      const result = resetRuntimeCounter(currentCounters, counterId);
      if (result === undefined) {
        continue;
      }
      const carryBefore = currentCounters[counterId]?.carry ?? 0;
      // `effectSequenceCounters`は`skillCounters`と異なり、この
      // 解決が完了したら`skillUseId`エントリ自体も完全に消す（空の`{}`を
      // 残す既存の非対称な規約を流用しない — `captureBattleState`/
      // `applyTwoLevelCounterDeltas`（`pruneEmptyFirstLevelEntries`）が実状態と
      // 一致させるためにも、最後のcounterを消した時点でキー自体を削除する）。
      const nextEffectSequenceCounters = { ...currentActor.effectSequenceCounters };
      if (Object.keys(result.counters).length === 0) {
        delete nextEffectSequenceCounters[skillUseId];
      } else {
        nextEffectSequenceCounters[skillUseId] = result.counters;
      }
      const hasRemainingEntries = Object.keys(nextEffectSequenceCounters).length > 0;
      const { effectSequenceCounters: _omit, ...actorWithoutCounters } = currentActor;
      const updatedActor: BattleUnit = hasRemainingEntries
        ? { ...actorWithoutCounters, effectSequenceCounters: nextEffectSequenceCounters }
        : actorWithoutCounters;
      this.units = this.units.map((u) =>
        u.battleUnitId === updatedActor.battleUnitId ? updatedActor : u,
      );
      const recorded = this.context.recorder.record({
        eventType: "RuntimeCounterReset",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: this.context.rootEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: resolution.actorUnitId,
        payload: {
          ownerUnitId: resolution.actorUnitId,
          scope: "EFFECT_SEQUENCE",
          counter: counterId,
          skillDefinitionId: resolution.skillDefinitionId,
          before: result.change.before,
        },
        stateDelta: {
          units: {
            [resolution.actorUnitId]: {
              effectSequenceCounters: {
                [skillUseId]: { [counterId]: { before: result.change.before, after: undefined } },
              },
              ...(carryBefore !== 0
                ? {
                    effectSequenceCounterCarry: {
                      [skillUseId]: { [counterId]: { before: carryBefore, after: undefined } },
                    },
                  }
                : {}),
            },
          },
        },
      });
      yield recorded;
    }
  }

  /**
   * EFF-006: `finalizeEffectSequenceResolutionSteps`のトップレベル
   * 版。呼び出し側（AS/EX使用・チャージ解放）が、1つのEffectSequenceの解決
   * （`applyEffectActionGroups`の戻り）を受け取った直後に必ず1回呼ぶ。各
   * `RuntimeCounterReset`を`this.onFactEvent`へ再帰させ、その候補解決を
   * 完全に終えてから次のcounterへ進む（`finalizeResolutionScope`と同じ
   * トップレベル専用の駆動方法 — PS連鎖内部からはこのメソッドを呼んではならない、
   * 代わりに`finalizeEffectSequenceResolutionSteps`を`yield*`委譲すること）。
   */
  finalizeEffectSequenceResolution(skillUseId: SkillUseId): readonly BattleUnit[] {
    for (const recorded of this.finalizeEffectSequenceResolutionSteps(skillUseId)) {
      this.units = this.onFactEvent(recorded, this.units).units;
    }
    return this.units;
  }

  /**
   * `applyDamageAction`等が確定させたFACT/TIMINGイベントの都度呼び出す
   * トップレベルのエントリーポイント。PS発動で変化した`units`をそのまま返す。
   *
   * このメソッドは常に新しい`resolvePassiveChain`呼び出し（新しい`ChainState`・
   * guardスナップショット）を起こすため、既に別の`resolvePassiveChain`呼び出しが
   * 進行中の文脈（`activatePassiveCandidate`のgenerator本体など）から呼び出しては
   * ならない — 進行中の呼び出しが完了した際に`this.guard`を上書きし、この
   * メソッド内で記録した発動をロストする。
   * そのような文脈では代わりに`PassiveActivationStep`を`yield`し、進行中の
   * `driveActivation`が共有する`state`（guard/stack）へ正しく参加させること。
   *
   * 戻り値は`ResolutionResult`——`units`に加え、この呼び出し
   * 自身が発行・解決した反応連鎖まで含めた実際の終端`DomainEventId`を
   * `lastEventId`として明示的に返す（`finalizeResolutionScope`と同じ`recorder`
   * 末尾読み取りパターン）。カーソルを必要としない大多数の呼び出し側は
   * `.units`だけを取り出せばよい。
   *
   * `recorder.getEvents()`の単純な末尾ではなく、
   * この呼び出し自身が開始した時点からの差分だけを見る——呼び出し側が複数の
   * イベントを先に一括で`record`してから1件ずつ`onFactEvent`へ渡す経路
   * （`action-completion.ts`の期間/Marker更新など）では、対象`event`より後の
   * 無関係な後続イベントが呼び出し前から既に`recorder`に存在し得るため、単純な
   * 末尾は他エントリの終端イベントを誤って返してしまう。この呼び出し中に何も
   * 追加されなければ（新規のPS/Memory連鎖・counter更新が無い、産業上最も
   * 多いケース）、`event`自身を`lastEventId`として返す。
   */
  onFactEvent(
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
    counterUpdateDepth = 0,
  ): ResolutionResult {
    const eventsStart = this.context.recorder.getEvents().length;
    this.units = units;
    const triggerEvent = this.toTriggerEvent(event);

    const nextDepth = counterUpdateDepth + 1;
    for (const recorded of this.detectAndRecordRuntimeCounterChanges(event)) {
      if (nextDepth > this.limits.maxEffectRuntimeCounterDepth) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${this.limits.maxEffectRuntimeCounterDepth} rounds; a counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth).units;
    }

    // EFF-005: `AppliedEffect`スコープの
    // counter更新も、上の`SKILL_RUNTIME`スコープと同じくR-EFF-08
    // （`applyExpirationConditions`）より先に確定させる — 更新後の値をそのまま
    // `expiration.conditions`が読めるようにする（R-EFF-11の同じ規則）。
    // `applyEffectRuntimeCounterUpdates`自身が`processedEffectRuntimeCounterEventIds`
    // で二重処理を防ぐため、後続の`resolvePassiveChain`（`deps.
    // applyEffectRuntimeCounterUpdates`が同じ`triggerEvent`を再度処理しようと
    // しても）安全にno-opになる。`resolveChild`はこの再帰的`onFactEvent`
    // 呼び出し自体であり、record 1件ごとにその候補連鎖を完全に解決してから
    // 次のエントリへ進む。
    this.applyEffectRuntimeCounterUpdates(triggerEvent, (recorded) => {
      if (nextDepth > this.limits.maxEffectRuntimeCounterDepth) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${this.limits.maxEffectRuntimeCounterDepth} rounds; a DurationDefinition.counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth).units;
      return undefined;
    });

    // EFF-006: `EffectSequence`スコープも同じ理由・同じ順序
    // （`applyExpirationConditions`より先）で確定させる。
    this.applyEffectSequenceRuntimeCounterUpdates(triggerEvent, (recorded) => {
      if (nextDepth > this.limits.maxEffectRuntimeCounterDepth) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${this.limits.maxEffectRuntimeCounterDepth} rounds; an EffectSequence.counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth).units;
      return undefined;
    });

    // R-EFF-08は「関連するドメインイベント発行後、
    // PS/Memory候補の抽出前に評価する」ことを要求する。`onFactEvent`はFACT/
    // TIMINGイベントの都度呼ばれる唯一の共通経路（`ActionCompleted`だけでなく
    // `DamageApplied`/`UnitDefeated`/`TurnCompleted`等すべて）のため、ここで
    // 評価すれば個別の呼び出し元ごとに配線し直す必要がない。失効で新たに
    // 発行された`EffectExpired`等も、この`event`自身のPS候補解決より前に
    // 自身のPS候補解決を終える（再帰depthは`RuntimeCounterChanged`と同じ
    // 上限を共有する）。
    this.units = this.applyExpirationConditions(event, nextDepth);

    // R-EFF-10（M7-020）: 付与者の戦闘不能によるMarker解除も、R-EFF-08と
    // 同じ「関連するドメインイベント発行後、PS/Memory候補の抽出前」で評価する。
    // R-EFF-08の後に置くのは、`expiration.conditions`を持つ`AppliedEffect`が
    // 同じ`UnitDefeated`を観測する既存の順序を変えないため（両者は独立した機構で、
    // どちらが先でも解除結果自体は変わらない — 先行する側が発行したイベントは
    // 後続側の評価前に`onFactEvent`へ再帰して完全に解決される）。
    this.units = this.applyMarkerSourceDefeatRemovals(event, nextDepth);

    // 上記はトップレベルの`event`しかカバーせず、
    // PS連鎖の内部（`activatePassiveCandidate`が直接yieldする`PassiveActivated`・
    // `EffectActionStarting`等）は`onFactEvent`を経由しないため見落とされていた。
    // `resolvePassiveChain`（`resolve-passive-chain.ts`の`resolveEvent`）へ
    // `applyExpirationConditionsForChain`を`deps.applyExpirationConditions`として
    // 注入し、PS連鎖内部の各イベントに対しても候補抽出直前に同じ評価を行う。
    // トップレベルの`event`自身は上の呼び出しで既に失効済みのため、
    // `resolveEvent`側の評価は該当なし（no-op）になる — 二重発行はしない。
    //
    // R-ATM-01: 効果処理フェーズの進行中は、ここまでの状態保守だけを確定させ、
    // 候補は検出して保留キューへ積む（発動は`drainEffectProcessingPhase`）。
    // 上の状態保守が発行した子イベントもこの`onFactEvent`へ再帰しているため、
    // キュー内では子イベントの候補が`event`自身の候補より前に並ぶ。
    const deferralFrame = this.defersActivationOf(event)
      ? this.pendingEffectProcessingFrames[this.pendingEffectProcessingFrames.length - 1]
      : undefined;
    if (deferralFrame !== undefined) {
      deferralFrame.push(detectPassiveCandidateGroup(triggerEvent, this.buildDependencies()));
      const deferredEvents = this.context.recorder.getEvents();
      const lastDeferred =
        deferredEvents.length > eventsStart ? deferredEvents[deferredEvents.length - 1] : undefined;
      return { units: this.units, lastEventId: lastDeferred?.eventId ?? event.eventId };
    }

    const result = resolvePassiveChain(triggerEvent, this.guard, this.buildDependencies());
    if (!result.ok) {
      throw new ExecutionGuardExceededError(
        `PS chain resolution exceeded its execution guard: ${result.reason}`,
      );
    }
    this.guard = result.activationGuard;
    const recordedEvents = this.context.recorder.getEvents();
    const last =
      recordedEvents.length > eventsStart ? recordedEvents[recordedEvents.length - 1] : undefined;
    return { units: this.units, lastEventId: last?.eventId ?? event.eventId };
  }

  /**
   * `applyExpirationConditions`/`applyMarkerSourceDefeatRemovals`とその
   * `ForChain`版（`./expiration-marker-removal-application-service.js`、
   * REF-063 #2）へ渡す共通envelope。
   */
  private expirationMarkerRemovalContext(): ExpirationMarkerRemovalContext {
    return {
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      resolutionScopeId: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
    };
  }

  /**
   * R-EFF-08: `event`に対して`expiration.conditions`が成立した効果インスタンスを
   * 即時に失効させる（トップレベルの`onFactEvent`専用）。実装・詳細な理由は
   * `./expiration-marker-removal-application-service.js`（REF-063 #2）へ抽出した。
   */
  private applyExpirationConditions(
    event: BattleDomainEvent,
    depth: number,
  ): readonly BattleUnit[] {
    return applyExpirationConditionsService(
      this.expirationMarkerRemovalContext(),
      this.context.definitions.effectActions,
      this.units,
      event,
      depth,
      this.limits.maxEffectRuntimeCounterDepth,
      (newEvent, unitsForChain) => this.onFactEvent(newEvent, unitsForChain, depth).units,
    );
  }

  /**
   * R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020）: `event`が
   * `UnitDefeated`のとき、`duration.removeOnSourceDefeated`を宣言し付与者が
   * その戦闘不能ユニットであるMarkerを即時に解除する。実装・詳細な理由は
   * `./expiration-marker-removal-application-service.js`（REF-063 #2）へ抽出した。
   */
  private applyMarkerSourceDefeatRemovals(
    event: BattleDomainEvent,
    depth: number,
  ): readonly BattleUnit[] {
    return applyMarkerSourceDefeatRemovalsService(
      this.expirationMarkerRemovalContext(),
      this.context.definitions.effectActions,
      this.units,
      event,
      depth,
      this.limits.maxEffectRuntimeCounterDepth,
      (newEvent, unitsForChain) => this.onFactEvent(newEvent, unitsForChain, depth).units,
    );
  }

  /**
   * R-EFF-08: `applyExpirationConditions`のPS連鎖内部版。実装・詳細な理由は
   * `./expiration-marker-removal-application-service.js`（REF-063 #2）へ抽出した。
   */
  private applyExpirationConditionsForChain(
    event: TriggerCandidateEvent,
  ): readonly TriggerCandidateEvent[] {
    const result = applyExpirationConditionsForChainService(
      this.expirationMarkerRemovalContext(),
      this.context.definitions.effectActions,
      this.chainExpirationDepth,
      this.limits.maxEffectRuntimeCounterDepth,
      this.units,
      event,
      this.eventIdOf(event),
      (recorded) => this.toTriggerEvent(recorded),
    );
    this.units = result.units;
    return result.events;
  }

  /**
   * R-EFF-10（M7-020）: `applyMarkerSourceDefeatRemovals`のPS連鎖内部版。
   * 実装・詳細な理由は`./expiration-marker-removal-application-service.js`
   * （REF-063 #2）へ抽出した。
   */
  private applyMarkerSourceDefeatRemovalsForChain(
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined {
    return applyMarkerSourceDefeatRemovalsForChainService(
      this.expirationMarkerRemovalContext(),
      this.context.definitions.effectActions,
      this.chainExpirationDepth,
      this.limits.maxEffectRuntimeCounterDepth,
      () => this.units,
      (units) => {
        this.units = units;
      },
      (recorded) => this.toTriggerEvent(recorded),
      event,
      this.eventIdOf(event),
      resolveChild,
    );
  }

  /**
   * `R-EFF-11`「解決スコープ終了時にリセットするcounter」。呼び出し側
   * （`resolveSkillUse`／charge解放／`advanceBattle`の
   * `TurnStarted`処理など、このインスタンスが担当する1解決スコープを完全に終えた
   * 箇所）が、そのスコープ内の最後の`onFactEvent`呼び出し後に必ず1回呼び出す。
   * `resetScope: "RESOLUTION_SCOPE"`を宣言し現在値を持つcounterを破棄して
   * `RuntimeCounterReset`を発行し、その候補解決（`onFactEvent`経由、トップ
   * レベルの呼び出しのため安全）を行う。この候補解決が同じスコープへ新しい
   * 対象counterを生成・更新した場合は、リセット対象counterが残らなくなるまで
   * 「破棄→発行→候補解決」を繰り返す。対象12行はいずれも`resetScope`を宣言
   * しないため、この処理は常に即座に`this.units`をそのまま返す。
   *
   * `resetScope: RESOLUTION_SCOPE`のcounterが、自身の
   * `RuntimeCounterReset`をtriggerとする`counterUpdates`を持つ場合
   * （破棄→発行→その候補解決で同じcounterが即座に再生成される）、このwhileは
   * 決して`targets`が空にならず同期的に無限ループする。counter更新はPS発動
   * 済みGuard（`R-PS-07`）を通らないため、既存のPassiveChainLimitsもこの
   * ループ自体を止めない。反復回数の上限を設け、超過時は黙って打ち切る代わりに
   * 決定的なエラーとして検出する。
   *
   * 呼び出し側がこの解決スコープへ入る直前に保持していた因果
   * カーソル（`cursor`）を引数で受け取り、戻り値は`onFactEvent`と同じ
   * `ResolutionResult`（`units`と確定値の`lastEventId`）で統一する。
   * `recorder.getEvents()`の末尾を呼び出し側が推測する方式は採らない。
   *
   * 何も破棄しなかった場合（対象12行のように`resetScope`を宣言しない場合が
   * 常時これに該当）、この呼び出し自身は何も発行していない——受け取った
   * `cursor`をそのまま`lastEventId`として返し、呼び出し側が保持していた
   * 因果カーソルを無関係な`rootEventId`で上書きしない。
   *
   * 何か破棄・発行した場合は、`onFactEvent()`が返す`lastEventId`
   * （`RuntimeCounterReset`自身がPS/Memory候補を発動させた場合はその候補連鎖・
   * 付随する効果適用まで含めた実際の終端イベント）をそのまま採用する。
   */
  finalizeResolutionScope(cursor: DomainEventId, units?: readonly BattleUnit[]): ResolutionResult {
    // このruntimeは`onFactEvent`が渡された`units`だけを
    // 追跡する。イベントを伴わない純粋な状態変化（ターン単位期間の減算など）を
    // 呼び出し側が挟んだ場合、`this.units`はその分だけ古いため、スコープ終了時に
    // 最新の`units`を明示的に同期できるようにする（未指定なら従来どおり
    // `onFactEvent`が最後に受け取った状態から続ける）。
    if (units !== undefined) {
      this.units = units;
    }
    let lastEventId: DomainEventId = cursor;
    let round = 0;
    while (true) {
      const targets = collectResolutionScopeResets({
        units: this.units,
        unitDefinitions: this.context.definitions.unitDefinitions,
        skillDefinitions: this.context.definitions.skillDefinitions,
      });
      if (targets.length === 0) {
        return { units: this.units, lastEventId };
      }
      round += 1;
      if (round > MAX_RESOLUTION_SCOPE_RESET_ROUNDS) {
        throw new ExecutionGuardExceededError(
          `finalizeResolutionScope exceeded ${MAX_RESOLUTION_SCOPE_RESET_ROUNDS} discard/emit/resolve rounds; a counterUpdates definition likely re-triggers its own resetScope: RESOLUTION_SCOPE counter from the RuntimeCounterReset event it causes (infinite regeneration)`,
        );
      }
      for (const target of targets) {
        const owner = requireUnit(this.units, target.ownerUnitId);
        const counters = owner.skillCounters?.[target.skillDefinitionId] ?? {};
        // 破棄されるcarryもstateDeltaへ含めるため、
        // `resetRuntimeCounter`が削除する前に読み取っておく。
        const carryBefore = counters[target.counter]?.carry ?? 0;
        const result = resetRuntimeCounter(counters, target.counter);
        if (result === undefined) {
          continue;
        }
        const updatedOwner: BattleUnit = {
          ...owner,
          skillCounters: { ...owner.skillCounters, [target.skillDefinitionId]: result.counters },
        };
        this.units = this.units.map((u) =>
          u.battleUnitId === owner.battleUnitId ? updatedOwner : u,
        );
        const recorded = this.context.recorder.record({
          eventType: "RuntimeCounterReset",
          category: "FACT",
          turnNumber: this.context.turnNumber,
          cycleNumber: this.context.cycleNumber,
          ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
          resolutionScopeId: this.context.resolutionScopeId,
          parentEventId: this.context.rootEventId,
          rootEventId: this.context.rootEventId,
          sourceUnitId: target.ownerUnitId,
          payload: {
            ownerUnitId: target.ownerUnitId,
            scope: "SKILL_RUNTIME",
            counter: target.counter,
            skillDefinitionId: target.skillDefinitionId,
            before: result.change.before,
          },
          stateDelta: {
            units: {
              [target.ownerUnitId]: {
                skillCounters: {
                  [target.skillDefinitionId]: {
                    // `after: 0`ではなく`undefined`にして、
                    // 独立Reducerがキー自体を削除できるようにする（実状態の
                    // `resetRuntimeCounter`と同じく、値0で残すのではなく削除）。
                    [target.counter]: { before: result.change.before, after: undefined },
                  },
                },
                // carryが実際に非0だった場合だけ
                // `skillCounterCarry`を持つ（0のcarryは元々`captureBattleState`
                // が省略するキーのため、削除する意味のある差分がない）。
                ...(carryBefore !== 0
                  ? {
                      skillCounterCarry: {
                        [target.skillDefinitionId]: {
                          [target.counter]: { before: carryBefore, after: undefined },
                        },
                      },
                    }
                  : {}),
              },
            },
          },
        });
        const resolved = this.onFactEvent(recorded, this.units);
        this.units = resolved.units;
        lastEventId = resolved.lastEventId;
      }
    }
  }

  /**
   * `08_ドメインイベント.md`「発動直前の再確認」Memory候補「trigger conditionが
   * 現在も成立」: 候補検出（R-MEM-01）と同じ照合を、発動直前の最新`this.units`で
   * もう一度行う。PS側の`reconfirmPassiveCandidate`（PP・クールタイム・発動済み
   * 集合も見る）と異なり、Memoryはtrigger自身の成立だけを見る（R-MEM-01「Memory
   * triggeredEffects はPP、クールタイム、先制攻撃、1解決スコープ1回制限を
   * 持たない」）。
   */
  private reconfirmMemoryCandidate(
    candidate: MemoryCandidate,
    event: TriggerCandidateEvent,
  ): boolean {
    return matchesMemoryTrigger({
      trigger: candidate.triggeredEffect.trigger,
      side: candidate.side,
      event,
      units: this.units,
      ...(this.context.resolutionPhase !== undefined
        ? { resolutionPhase: this.context.resolutionPhase }
        : {}),
      turnNumber: this.context.turnNumber,
    });
  }

  /**
   * R-MEM-04「Memory の `EffectSequence` はスキルと同じく `R-SKL-01` から
   * `R-SKL-08` に従って解決する」: PSの`activatePassiveCandidate`に対応する
   * Memory版。R-MEM-01「Memory triggeredEffects はPP、クールタイム、先制攻撃、
   * 1解決スコープ1回制限を持たない」ため、PP消費・EX増加・クールタイム設定・
   * 発動済み集合への登録を一切行わず、`MemoryTriggered`→EffectSequence解決→
   * `MemoryResolved`だけを行う。使用者BattleUnitを持たない（R-MEM-04）ため
   * R-SKL-01の使用者戦闘不能による中断も持たず、常に`interrupted: false`を返す。
   *
   * `08_ドメインイベント.md`「発動直前の再確認」Memory候補「対象候補が1件以上
   * 存在する」: 対象解決（`resolveMemoryEffectSequenceOrder`）の結果が0件の場合は
   * `MemoryTriggered`自体を発行せずに終える（PS側の`PassiveCandidateSuppressed`
   * と同じくDIAGNOSTICイベントは発行しない — 既存のPS実装が
   * `PassiveCandidateDetected`/`Suppressed`を発行していないのと同じ扱い、
   * `08_ドメインイベント.md`「発行自体を省略する実装も許容する」）。
   */
  private *activateMemoryCandidate(
    candidate: MemoryCandidate,
    event: TriggerCandidateEvent,
  ): Generator<PassiveActivationStep, { readonly interrupted: boolean }, unknown> {
    const triggerEventId = this.eventIdOf(event);
    const sequence = candidate.triggeredEffect.effectSequence;
    if (sequence.counterUpdates !== undefined && sequence.counterUpdates.length > 0) {
      // `EFFECT_SEQUENCE`スコープのRuntimeCounterは保持者ユニット
      // （`BattleUnit.effectSequenceCounters`、EFF-006）を前提とするため、
      // 使用者を持たないMemoryからは扱えない。黙って無視せず明確に拒否する。
      throw new DomainValidationError(
        "memory.triggeredEffects.effectSequence.counterUpdates",
        "EffectSequence-scoped RuntimeCounters require an owner BattleUnit, which Memory triggeredEffects do not have (R-MEM-04)",
      );
    }

    // CAP_TRIGGER_CONTEXT（RES-005）/ CAP_TRIGGER_PAYLOAD_IN_RESOLUTION:
    // PS側と同じく、候補検出に使った原因イベントの発生源・対象・payloadを
    // そのまま解決へ渡す（`TRIGGER_SOURCE`/`TRIGGER_TARGET`はMemoryでも使える
    // ——`SELF`と異なり具体的な使用者を必要としないため）。
    const triggerContext: TriggerContext = {
      ...(event.sourceUnitId !== undefined ? { triggerSourceUnitId: event.sourceUnitId } : {}),
      ...(event.targetUnitIds !== undefined ? { triggerTargetUnitIds: event.targetUnitIds } : {}),
      triggerEventPayload: event.payload,
    };

    const plan = resolveMemoryEffectSequenceOrder(
      sequence,
      candidate.side,
      this.units,
      this.context.definitions.effectActions,
      triggerContext,
      this.context.definitions.unitDefinitions,
    );
    if (plan.targetUnitIds.length === 0) {
      return { interrupted: false };
    }

    // `08_ドメインイベント.md`「MemoryTriggered から発生するEffectSequenceイベントは、
    // 同じ`effectSequenceId`と`sourceSide`を引き継ぐ」: 1件のMemory解決を識別する
    // 実行時IDとして、PSと同じく`SkillUseId`を採番して全イベントへ伝播させる。
    const skillUseId = this.context.recorder.nextSkillUseId();
    const memoryTriggered = this.context.recorder.record({
      eventType: "MemoryTriggered",
      category: "FACT",
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      resolutionScopeId: this.context.resolutionScopeId,
      parentEventId: triggerEventId,
      rootEventId: this.context.rootEventId,
      // `08_ドメインイベント.md`: Memoryイベントは`sourceUnitId`を持たず`sourceSide`を持つ。
      sourceSide: candidate.side,
      payload: {
        memoryDefinitionId: candidate.memoryDefinitionId,
        triggeredEffectIndex: candidate.triggeredEffectIndex,
        sourceSide: candidate.side,
        triggerEventId,
      },
    });
    // `MemoryTriggered`自身も別のPS/Memoryの発動契機になり得る
    // （`08_ドメインイベント.md`「PS/Memoryからの連鎖」）ため、PSの
    // `PassiveActivated`と同じくTIMING_EVENTとしてyieldし、進行中の連鎖へ参加させる。
    yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(memoryTriggered) };

    // R-ATM-03（R-ATM-02 #1の表、Memory行）の攻撃前観測はこの経路には現れない。
    // `UnitBeingAttacked` payloadは発生源スキル（`skillDefinitionId`）を必須に持つ
    // 一方、MemoryのEffectSequenceは所有スキルを持たない（R-MEM-04）。DAMAGEを
    // 含むMemory定義は`requireSkillDefinitionId`が解決時に拒否するため、観測すべき
    // 攻撃自体がMemoryからは成立しない（現行production Catalogにも該当定義は無い）。
    const groupContext: EffectActionGroupContext = {
      definitions: this.context.definitions,
      // R-MEM-04: 使用者BattleUnitを持たず、Memoryを指定した陣営をsource sideとする。
      sourceSide: candidate.side,
      random: this.context.random,
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      actionScope: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
      parentEventId: memoryTriggered.eventId,
      damageResults: this.damageResults,
      ...(this.context.exercise !== undefined ? { exercise: this.context.exercise } : {}),
      ...triggerContext,
    };
    // R-TEX-06 #8: MemoryのEffectSequenceも`R-ATM-02`の3フェーズを持つため、ここから
    // 効果処理フェーズとしてブレイク保留フレームを開く。`R-ATM-01`の保留キュー側の
    // 対応するフレームは`resolve-passive-chain.ts`の`driveSteps`が持つ。
    this.breakDeferral?.beginEffectProcessing();
    const box: UnitsBox = { units: this.units };
    const generator = resolveEffectSequencePlan(plan, box, groupContext);
    let lastEventId: DomainEventId = memoryTriggered.eventId;
    let step = generator.next();
    while (!step.done) {
      this.units = box.units;
      if (step.value.kind === "TIMING_EVENT") {
        yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(step.value.event) };
      } else {
        yield {
          kind: "EFFECT_RESOLVED",
          events: step.value.events.map((resolved) => this.toTriggerEvent(resolved)),
        };
      }
      box.units = this.units;
      const lastYielded =
        step.value.kind === "TIMING_EVENT"
          ? step.value.event
          : step.value.events[step.value.events.length - 1];
      if (lastYielded !== undefined) {
        lastEventId = lastYielded.eventId;
      }
      step = generator.next();
    }
    this.units = box.units;

    // R-TEX-06 #5: 効果処理フェーズの末尾（`MemoryResolved`の発行前）で保留ブレイクを
    // 解決する。Memory経路は追撃（R-FUP-01はAS/EX専用）も`EffectSequence`スコープ
    // counter（R-MEM-04により持てない）も無いため、ここが末尾そのものである。
    lastEventId = yield* this.resolveDeferredBreakSteps(skillUseId, lastEventId);

    const memoryResolved = this.context.recorder.record({
      eventType: "MemoryResolved",
      category: "FACT",
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      resolutionScopeId: this.context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: this.context.rootEventId,
      sourceSide: candidate.side,
      payload: {
        memoryDefinitionId: candidate.memoryDefinitionId,
        triggeredEffectIndex: candidate.triggeredEffectIndex,
        sourceSide: candidate.side,
        resolvedStepCount: sequence.steps.length,
      },
    });
    // `R-ATM-02` #3: Memoryの完了イベント。保留キューを排出してから自身の候補を
    // 解決させるため`COMPLETION_EVENT`としてyieldする。
    yield { kind: "COMPLETION_EVENT", event: this.toTriggerEvent(memoryResolved) };

    return { interrupted: false };
  }

  /**
   * R-PS-05「発動と再入防止」#2-6。発動済み集合への追加（#1）は
   * `resolvePassiveChain`（`resolveTopGroup`）が本関数を呼ぶ前に済ませている。
   */
  private *activatePassiveCandidate(
    candidate: PassiveCandidate,
    event: TriggerCandidateEvent,
  ): Generator<PassiveActivationStep, { readonly interrupted: boolean }, unknown> {
    const skill = candidate.skillDefinition;
    const ownerId = candidate.unit.battleUnitId;
    const triggerEventId = this.eventIdOf(event);
    // PSも一つのSkillUse（`08_ドメインイベント.md`「同じ
    // SkillUseIdに属するイベントを関連づける。PSも一つのスキル使用として新しい
    // SkillUseIdを持つ」）。以前はEffectSequence解決直前(旧`skillUseId`採番位置)
    // でしか採番しておらず、それより前に発行するリソース・Cooldown・
    // `PassiveActivated`／終了後の`PassiveResolved`/`PassiveInterrupted`に
    // SkillUseIdが付かなかった。PS発動開始時点で採番し、このPSに属する全イベント
    // （終了イベントまで）へ伝播させる。
    const skillUseId = this.context.recorder.nextSkillUseId();
    const resourceCtx = toResourceChangeContext(this.context, skillUseId);

    // R-PS-05 #2: PPを消費し、消費量と同量だけEXゲージを増やす（R-ACT-03/超過切り捨て）。
    const ownerBefore = requireUnit(this.units, ownerId);
    this.units = consumePp(this.units, ownerId, skill.cost.amount);
    const ownerAfterPp = requireUnit(this.units, ownerId);
    let lastEventId = recordResourceChangeIfAny(
      resourceCtx,
      ownerId,
      "PP",
      ownerBefore.currentPp,
      ownerAfterPp.currentPp,
      ownerAfterPp.currentPp - ownerBefore.currentPp,
      "SKILL_COST",
      triggerEventId,
      triggerEventId,
    );
    if (ownerBefore.currentPp !== ownerAfterPp.currentPp) {
      const consumed = this.context.recorder.record({
        eventType: "PassivePointConsumed",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          before: ownerBefore.currentPp,
          after: ownerAfterPp.currentPp,
          consumedAmount: skill.cost.amount,
        },
      });
      lastEventId = consumed.eventId;
    }

    const resourceGainRate = composeResourceGainRate(
      requireUnit(this.units, ownerId),
      "EX_GAUGE",
      this.context.definitions.effectActions,
    );
    const exGain = increaseExGauge(this.units, ownerId, skill.cost.amount, resourceGainRate);
    this.units = exGain.units;
    lastEventId = recordResourceChangeIfAny(
      resourceCtx,
      ownerId,
      "EX_GAUGE",
      exGain.before,
      exGain.after,
      exGain.baseDelta,
      "EX_GAIN",
      lastEventId,
      triggerEventId,
    );
    if (exGain.after !== exGain.before) {
      const increased = this.context.recorder.record({
        eventType: "ExtraGaugeIncreased",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          battleUnitId: ownerId,
          causeResource: "PP",
          before: exGain.before,
          after: exGain.after,
          increasedAmount: exGain.after - exGain.before,
        },
      });
      lastEventId = increased.eventId;
    }
    lastEventId = recordExtraGaugeOverflowDiscardedIfAny(
      resourceCtx,
      ownerId,
      exGain.baseDelta,
      exGain.requestedAmount,
      exGain.after - exGain.before,
      exGain.discardedAmount,
      lastEventId,
    );

    // R-PS-05 #3: クールタイムを設定する。
    const ownerAfterResources = requireUnit(this.units, ownerId);
    const cooldownResult = recordCooldownStart(
      this.context.recorder,
      {
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        resolutionScopeId: this.context.resolutionScopeId,
        actorUnitId: ownerId,
      },
      ownerAfterResources.cooldowns,
      skill,
      lastEventId,
      this.context.rootEventId,
    );
    this.units = this.units.map((unit) =>
      unit.battleUnitId === ownerId ? { ...unit, cooldowns: cooldownResult.cooldowns } : unit,
    );
    lastEventId = cooldownResult.lastEventId;

    // R-PS-05 #4: 発動済み集合への登録とPP消費後に`PassiveActivated`を発行する。
    const passiveActivated = this.context.recorder.record({
      eventType: "PassiveActivated",
      category: "FACT",
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      resolutionScopeId: this.context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: this.context.rootEventId,
      sourceUnitId: ownerId,
      payload: {
        actorUnitId: ownerId,
        skillDefinitionId: skill.skillDefinitionId,
        ppBefore: ownerBefore.currentPp,
        ppAfter: ownerAfterPp.currentPp,
        exBefore: exGain.before,
        exAfter: exGain.after,
        triggerEventId,
      },
    });
    lastEventId = passiveActivated.eventId;
    // `PassiveActivated`はこれまで直接record
    // するだけで`onFactEvent`を経由しておらず、これに反応するPS（例:「パッシブ
    // スキルをN回使用するたびに発動」のRuntimeCounter更新）が検出されなかった。
    // ただし本メソッドは常に進行中の`resolvePassiveChain`（`driveActivation`）の
    // 内側から呼ばれるため、`this.onFactEvent()`を再帰呼び出しすると新しい
    // `resolvePassiveChain`が別のguardスナップショットから走り、進行中の呼び出し
    // が完了した際に発動記録を上書きしてしまう（R-PS-07違反）。counter更新自体は
    // guard/stackに触れないため直接検出・記録し、候補解決は`TIMING_EVENT`として
    // yieldして進行中の`driveActivation`が共有する`state`へ正しく参加させる
    // （`RuntimeCounterChanged`→`PassiveActivated`の順。前者の候補解決を後者より
    // 先に完了させる「複合処理と状態差分の所有」のpre-matching例外と同じ順序）。
    const runtimeCounterChanges = this.detectAndRecordRuntimeCounterChanges(
      passiveActivated,
      skillUseId,
    );
    for (const changed of runtimeCounterChanges) {
      yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(changed) };
      lastEventId = changed.eventId;
    }
    yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(passiveActivated) };
    // 上記の候補解決で`ownerId`自身の状態が変わりうるため、`resolveSkillOrder`
    // へ渡す`actor`スナップショットを最新の`this.units`から取り直す
    // （クールタイム設定直後の古いスナップショットのままだと、直前の連鎖が
    // 加えた変更を`plan`の解決から見落とす）。
    const ownerAfterChainedActivations = requireUnit(this.units, ownerId);

    // CAP_TRIGGER_CONTEXT（RES-005）: このPSを発動させた原因
    // イベント（`event`、候補検出に使ったもの）の発生源・対象。
    // `TargetReference.kind: TRIGGER_SOURCE`/`TRIGGER_TARGET`はこれを参照する。
    // AS/EX使用や行動外トップレベルイベントには存在しないフィールドのため、
    // `event.sourceUnitId`/`targetUnitIds`が無ければ対応するフィールドを
    // 持たないまま素通しする。ここでは`BattleUnit`へ解決
    // せずIDのまま保持する — 先行するEffectActionや子PS連鎖が対象のHP・
    // combatStatsを変更した後も、実際に参照する各時点（`resolveReference`の
    // JIT解決、Formula評価、DAMAGE解決）で最新の`box.units`/`working`から
    // 都度引き直させるため。
    // CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（M7-001D）: この同じ原因
    // イベントの`payload`も、`resolution.steps`側の`EVENT_PAYLOAD`条件が
    // 参照できるよう素通しする（`triggers[].condition`が参照する
    // `EVENT_PAYLOAD`とは独立に、発動後の一部stepだけを条件付けられる）。
    const triggerContext: TriggerContext = {
      ...(event.sourceUnitId !== undefined ? { triggerSourceUnitId: event.sourceUnitId } : {}),
      ...(event.targetUnitIds !== undefined ? { triggerTargetUnitIds: event.targetUnitIds } : {}),
      triggerEventPayload: event.payload,
    };

    // R-PS-05 #5: EffectSequenceをR-SKL-01〜08に従って解決する。
    const plan = resolveSkillOrder(
      skill,
      ownerAfterChainedActivations,
      this.units,
      this.context.definitions.effectActions,
      triggerContext,
      this.context.definitions.unitDefinitions,
    );
    // ターン開始・終了など行動外の
    // トップレベルイベントから発動したPS（`actionId`を持たない）も実効果を
    // 解決できる。`EffectActionGroupContext`以下は`actionId`を任意にして
    // 素通しする。`EffectSequence.steps`はCatalog検証で非空のため、
    // `resolveEffectSequencePlan`は常に呼び出し、step単位のイベントを発行する
    // （#73: R-SKL-06）。
    //
    // 以前は`applyEffectActionGroups`でplan全体を同期的に
    // 適用してから、記録された全イベントを一つの`EFFECT_RESOLVED`として
    // まとめてyieldしていた。そのため最初のEffectAction Aが子PSを誘発しても、
    // その子PSが解決される時点では後続EffectAction Bも適用済みになり
    // （「親A→子PS→親B」ではなく「親A→親B→子PS」）、R-PS-06の親処理復帰契約に
    // 反していた。`resolveEffectSequencePlan`（generator）へ`yield*`委譲する
    // ことで、`resolvePassiveChain`の`driveActivation`が管理する共有state
    // （PassiveResolutionStack・深度Guard・効果解決数Guard）へ正しく参加し、
    // 各EffectAction/step境界で子PS連鎖を完全に解決してから次へ進むように
    // なる。
    // EFF-006: このPS自身のEffectSequence解決を開始する前に登録する
    // （`SkillUseStarting`相当のTIMINGはPSには無いため、前段フェーズの攻撃前観測
    // 以降に発行される全イベントを対象にできるようにする）。
    this.beginEffectSequenceResolution(
      skillUseId,
      ownerId,
      skill.skillDefinitionId,
      skill.resolution.counterUpdates ?? [],
    );

    // R-ATM-03: 前段フェーズの最後に攻撃前観測を行う（R-ATM-02 #1の表、PS行）。
    // `TIMING_EVENT`としてyieldするため、この候補は進行中の連鎖で直ちに解決される
    // （効果処理フェーズはこの後に始まるため保留対象にならない）。
    let observationInterrupted = false;
    for (const observation of collectPreAttackObservations(
      skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [],
      plan.resolvedBindings,
      ownerAfterChainedActivations,
      this.units,
      this.context.definitions.effectActions,
      triggerContext,
    )) {
      if (!shouldObserve(this.units, observation.targetUnitId)) {
        continue;
      }
      const recorded = recordPreAttackObservation(
        {
          recorder: this.context.recorder,
          turnNumber: this.context.turnNumber,
          cycleNumber: this.context.cycleNumber,
          ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
          skillUseId,
          resolutionScopeId: this.context.resolutionScopeId,
          rootEventId: this.context.rootEventId,
          skillDefinitionId: skill.skillDefinitionId,
          skillType: skill.skillType,
          attackerUnitId: ownerId,
        },
        observation,
        lastEventId,
      );
      lastEventId = recorded.eventId;
      yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(recorded) };
      // R-ATM-03 #5: PS所有者が戦闘不能になった場合は残りの観測を発行せず、
      // 効果処理フェーズへ進まずに`PassiveInterrupted`で終える。
      const owner = this.units.find((unit) => unit.battleUnitId === ownerId);
      if (owner === undefined || isDefeated(owner)) {
        observationInterrupted = true;
        break;
      }
    }

    const groupContext: EffectActionGroupContext = {
      definitions: this.context.definitions,
      actorUnitId: ownerId,
      random: this.context.random,
      recorder: this.context.recorder,
      turnNumber: this.context.turnNumber,
      cycleNumber: this.context.cycleNumber,
      ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
      skillUseId,
      actionScope: this.context.resolutionScopeId,
      rootEventId: this.context.rootEventId,
      parentEventId: lastEventId,
      skillDefinitionId: skill.skillDefinitionId,
      damageResults: this.damageResults,
      ...(this.context.exercise !== undefined ? { exercise: this.context.exercise } : {}),
      ...triggerContext,
    };

    // R-TEX-06 #8: PSのEffectSequenceも`R-ATM-02`の3フェーズを持つため、攻撃前観測
    // （前段フェーズ、R-ATM-03）の後・効果処理フェーズの開始と同じ位置でブレイク保留
    // フレームを開く。観測の候補解決で所有者が戦闘不能になった場合
    // （`observationInterrupted`）も開く — 対で必ず閉じるほうが単純であり、その場合は
    // 保留が1件も入らないまま空のフレームを閉じるだけになる。
    this.breakDeferral?.beginEffectProcessing();
    const box: UnitsBox = { units: this.units };
    const generator = observationInterrupted
      ? undefined
      : resolveEffectSequencePlan(plan, box, groupContext);
    let step = generator?.next() ?? {
      done: true as const,
      value: {
        units: this.units,
        outcome: {
          status: "INTERRUPTED" as const,
          reason: "ACTOR_DEFEATED" as const,
          resolvedEffectCount: 0,
          unresolvedEffectCount: 0,
        },
      },
    };
    while (!step.done) {
      // このyieldをresolvePassiveChainが処理する前に、ここまでの状態変化
      // （box.units）を`this.units`へ反映し、子PSの候補検出・発動が最新状態を
      // 見られるようにする。
      this.units = box.units;
      if (step.value.kind === "TIMING_EVENT") {
        yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(step.value.event) };
      } else {
        yield {
          kind: "EFFECT_RESOLVED",
          events: step.value.events.map((event) => this.toTriggerEvent(event)),
        };
      }
      // 子PS連鎖（あれば）が`this.units`を書き換えている可能性があるため、
      // 一時停止していたgeneratorを再開する前に`box.units`へ取り込む。
      box.units = this.units;
      const lastYielded =
        step.value.kind === "TIMING_EVENT"
          ? step.value.event
          : step.value.events[step.value.events.length - 1];
      if (lastYielded !== undefined) {
        lastEventId = lastYielded.eventId;
      }
      step = generator!.next();
    }
    this.units = box.units;
    const effectResult = step.value;
    const outcome = effectResult.outcome;

    // R-TEX-06 #5: 保留ブレイクの解決は、全stepの解決後・`EffectSequence`スコープの
    // `RuntimeCounterReset`より前・完了イベントの発行前に置く。counter破棄より前に
    // するのは、ブレイク解決が発行するイベントも当該EffectSequenceのcounter更新対象に
    // なり得るためである。R-TEX-06 #7: 中断（`outcome.status === "INTERRUPTED"`）でも
    // 解決する。
    lastEventId = yield* this.resolveDeferredBreakSteps(skillUseId, lastEventId);

    // EFF-006: このPS自身のEffectSequence解決が完了した時点で、
    // そのcounterを直ちに破棄する（`resolveEffectSequencePlan`が中断で終わった
    // 場合も含め、必ず1回だけ呼ぶ）。PS連鎖内部（このgenerator自身が
    // `driveActivation`に駆動されている）から呼んでいるため、
    // `finalizeEffectSequenceResolution`（トップレベル専用、内部で
    // `this.onFactEvent`を再帰させる）ではなく、`finalizeEffectSequenceResolutionSteps`
    // を`yield*`委譲し、`driveActivation`が共有するstateへ正しく候補解決させる。
    // `EffectSequence`スコープのResetは効果処理の末尾（完了イベント発行前）に
    // 発行されるため、候補は検出のみ行い発動は後段フェーズへ回す
    // （`R-ATM-02`、`08_ドメインイベント.md`「RuntimeCounterイベント」の分類表）。
    for (const recorded of this.finalizeEffectSequenceResolutionSteps(skillUseId)) {
      yield { kind: "DEFERRED_EVENT", event: this.toTriggerEvent(recorded) };
      lastEventId = recorded.eventId;
    }

    // 設計方針B: `PassiveInterrupted`/`PassiveResolved`の選択は
    // `outcome.status`（実際に解決が最後まで進んだか、PS所有者戦闘不能で
    // 打ち切ったかという事実）だけから決める。`unresolvedEffectCount`の値
    // からは決して導出しない（`INTERRUPTED`かつ`unresolvedEffectCount: 0`も
    // 正当な結果として扱う）。
    const resolvedStepCount =
      skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps.length : 0;
    let terminalEvent: BattleDomainEvent;
    if (outcome.status === "INTERRUPTED") {
      terminalEvent = this.context.recorder.record({
        eventType: "PassiveInterrupted",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          reason: "OWNER_DEFEATED",
          unresolvedEffectCount: outcome.unresolvedEffectCount,
        },
      });
    } else {
      terminalEvent = this.context.recorder.record({
        eventType: "PassiveResolved",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: ownerId,
        payload: {
          actorUnitId: ownerId,
          skillDefinitionId: skill.skillDefinitionId,
          resolvedStepCount,
        },
      });
    }
    // `PassiveActivated`と同じ理由で、
    // `PassiveResolved`/`PassiveInterrupted`もPS発動契機にできる契約
    // （08_ドメインイベント.md「同じSkillUseIdに属するイベント」節、
    // 「味方のPS解決後」を条件とするPS等）を満たすため、`COMPLETION_EVENT`として
    // yieldし進行中の`driveActivation`が共有するstateへ候補解決させる。
    // `RuntimeCounterChanged`（`terminalCounterChanges`）は`08_ドメインイベント.md`
    // が明示する唯一の前倒し例外のため、引き続き`terminalEvent`自身より先に
    // 保留キューへ積む（R-ATM-01の保留コンテキストでは「先に解決する」が
    // 「キュー内で前に並べる」へ読み替わる）。
    const terminalCounterChanges = this.detectAndRecordRuntimeCounterChanges(
      terminalEvent,
      skillUseId,
    );
    for (const changed of terminalCounterChanges) {
      yield { kind: "DEFERRED_EVENT", event: this.toTriggerEvent(changed) };
    }
    // TGT-004フェーズ3（08_ドメインイベント.md
    // 「イベント発行と処理」の順序契約）: `RuntimeCounterChanged`以外の子イベント
    // （`SKILL_USE`単位期間減算）は、原因イベント（`terminalEvent`＝
    // `PassiveResolved`）自身のPS/Memory候補解決より後でなければならない。
    // そのためSKILL_USE単位減算はこの`yield`より後で行う。ただし、この連鎖
    // 解決前のunitsスナップショット（`preTerminalChainUnits`）から減算対象
    // （`battleUnitId`+`effectInstanceId`のキーのみ）を決定する——
    // `PassiveResolved`に反応するPSがこのPS自身とは別の`skillUseId`で新たな
    // `SKILL_USE`期間効果を付与し得るため、連鎖解決後のunitsから対象を決定
    // すると、そのPSが付与したばかりの効果まで誤って減算・即時失効させてしまう。
    const preTerminalChainUnits = this.units;
    yield { kind: "COMPLETION_EVENT", event: this.toTriggerEvent(terminalEvent) };

    if (outcome.status !== "INTERRUPTED") {
      const skillUseDurationTargets = decrementSkillUseEffectDurations(
        preTerminalChainUnits,
        ownerId,
        skillUseId,
      ).changes.map((change) => ({
        battleUnitId: change.battleUnitId,
        effectInstanceId: change.effectInstanceId,
      }));
      // 決定した対象は`reapplySkillUseDurationDecrement`
      // で連鎖解決後のunitsへ適用する——連鎖解決前のスナップショット値
      // （before/after）をそのまま使い回さず、連鎖解決後の現在値から都度
      // 再計算する。`terminalEvent`自身のPS連鎖（上でyield済み）の中で、
      // その子PS自身の`PassiveResolved`が同じ対象へ独立にSKILL_USE単位減算を
      // かけている場合があるため（この親PSと子PSはどちらも同じownerの
      // 「1回のスキル使用完了」であり、互いに独立してR-EFF-04と同じ規約で
      // 減算する）——古いスナップショット値をそのまま設定すると、子PSが既に
      // 適用した減算を上書きし、2回分の減算のうち1回を消してしまう。対象インスタンスが
      // 連鎖解決中に既に除去されていた場合は`reapplySkillUseDurationDecrement`が無視する。
      const skillUseDurationDecrement = reapplySkillUseDurationDecrement(
        this.units,
        skillUseDurationTargets,
      );
      if (skillUseDurationDecrement.changes.length > 0) {
        this.units = skillUseDurationDecrement.units;
        const reducedEventsStart = this.context.recorder.getEvents().length;
        lastEventId = emitEffectDurationReducedEvents(
          {
            recorder: this.context.recorder,
            turnNumber: this.context.turnNumber,
            cycleNumber: this.context.cycleNumber,
            ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
            skillUseId,
            resolutionScopeId: this.context.resolutionScopeId,
            rootEventId: this.context.rootEventId,
          },
          this.units,
          skillUseDurationDecrement.changes,
          terminalEvent.eventId,
        );
        for (const event of this.context.recorder.getEvents().slice(reducedEventsStart)) {
          yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(event) };
        }

        const skillUseExpirySeeds: ExpirationSeed[] = skillUseDurationDecrement.changes
          .filter((change) => change.after === 0)
          .map((change) => ({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "TIME_LIMIT",
          }));
        if (skillUseExpirySeeds.length > 0) {
          const expiryEventsStart = this.context.recorder.getEvents().length;
          const skillUseExpiry = expireEffects(
            {
              recorder: this.context.recorder,
              turnNumber: this.context.turnNumber,
              cycleNumber: this.context.cycleNumber,
              ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
              skillUseId,
              resolutionScopeId: this.context.resolutionScopeId,
              rootEventId: this.context.rootEventId,
            },
            this.units,
            skillUseExpirySeeds,
            this.context.definitions.effectActions,
            lastEventId,
          );
          this.units = skillUseExpiry.units;
          for (const event of this.context.recorder.getEvents().slice(expiryEventsStart)) {
            yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(event) };
          }
        }
      }
    }

    return { interrupted: outcome.status === "INTERRUPTED" };
  }
}
