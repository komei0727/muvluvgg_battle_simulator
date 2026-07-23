import {
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
import type { LastDamageResultRegistry } from "../skill/formula-evaluator.js";
import { findEffectsMatchingExpirationCondition } from "./effect-expiration-condition-service.js";
import { expireEffects, type ExpirationSeed } from "../effects/duration-expiry-service.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
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
  applyMatchedRuntimeCounterUpdate,
  collectResolutionScopeResets,
  matchRuntimeCounterUpdates,
} from "../triggering/runtime-counter-matcher.js";
import {
  applyMatchedEffectRuntimeCounterUpdate,
  matchEffectRuntimeCounterUpdates,
} from "../triggering/runtime-counter-effect-matcher.js";
import {
  applyMatchedEffectSequenceRuntimeCounterUpdate,
  matchEffectSequenceRuntimeCounterUpdates,
  type ActiveEffectSequenceResolution,
} from "../triggering/effect-sequence-runtime-counter-matcher.js";
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
} from "../triggering/passive-chain-limits.js";
import type { PassiveCandidate } from "../triggering/passive-candidate.js";
import {
  resolvePassiveChain,
  type PassiveActivation,
  type PassiveActivationStep,
  type PassiveChainDependencies,
} from "../triggering/resolve-passive-chain.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";

/**
 * `finalizeResolutionScope`の「破棄→発行→候補解決」反復に対する上限
 * （レビュー指摘[P1]、Issue #143）。counter更新は`PassiveActivationGuard`
 * （R-PS-07）を経由しないため、`DEFAULT_PASSIVE_CHAIN_LIMITS`だけでは
 * 自己再生成する`resetScope`counterの無限ループを検出できない。対象12行は
 * いずれも`resetScope`を宣言しないため通常は1周も要さず、この上限に
 * 到達すること自体が誤ったCatalog定義を示す。
 */
const MAX_RESOLUTION_SCOPE_RESET_ROUNDS = 10;

/**
 * `onFactEvent`が自身の`RuntimeCounterChanged`を再帰的に候補解決へ回す深さの上限
 * （レビュー指摘[P2]、M6完了条件「実行ガードがPS深度とイベント数を監視する」
 * 13_実装計画.md参照）。`RuntimeCounterChanged`を自身の`counterUpdates.trigger`に
 * 持つCatalog定義は、更新→発行→候補解決の都度また同じcounterを更新しうるため、
 * この再帰は`PassiveChainLimits`（1解決スコープ単位のPS深度・効果解決数）にも
 * `EventRecorder`の総イベント数Guardにも到達する前にJSの呼び出しスタックを
 * 使い尽くしうる。決定的な`ExecutionGuardExceededError`として早期に検出する。
 * `onFactEvent`の再帰（`SKILL_RUNTIME`スコープ・トップレベルの`AppliedEffect`
 * スコープ）専用のカウンタで、`resolveEvent`自身の再帰を守る
 * `PassiveChainLimits.maxEffectRuntimeCounterDepth`（PS連鎖内部の`AppliedEffect`
 * スコープ、PR #211レビュー[P1]）とは別の経路のため同じ値を流用する。
 */
const MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH = 10;

/**
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の暫定既定値。
 * M9で設定可能にするまでの固定値（`13_実装計画.md`「実行保護の全上限を設定
 * 可能にする」）。
 */
export const DEFAULT_PASSIVE_CHAIN_LIMITS: PassiveChainLimits = {
  maxPassiveDepth: 8,
  maxEffectsPerScope: 50,
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
   * `RESOLUTION_PHASE`（Issue #144、TRIGGER_EXCLUSION_TIMING）が参照する、この
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
   * 成立させ続ける）を検出する再帰深度。`RuntimeCounterChanged`用の
   * `MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH`とは独立した別の自己再誘発
   * 経路のため、専用のカウンタで管理する。
   */
  private expirationConditionDepth = 0;
  /**
   * PR #211レビュー[P1]: `applyEffectRuntimeCounterUpdates`は`onFactEvent`の
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
   * （レビュー再指摘[P1]: このクラス側に単一のインスタンスフィールドを持たせると、
   * `resolveChild`による再帰的候補解決を待たずに呼び出しごとへリセットされ、
   * 上限が機能しない）。
   */
  private readonly processedEffectRuntimeCounterEventIds = new Set<DomainEventId>();
  /**
   * PR #211レビュー[P2]: `applyEffectRuntimeCounterUpdates`が発行する
   * `RuntimeCounterChanged`へ、原因イベントが属するPSのSkillUseへ関連付けるための
   * `skillUseId`を伝播するための逆引きmap。`toTriggerEvent`（原因イベントを
   * `TriggerCandidateEvent`化するたび）に、元の`BattleDomainEvent.skillUseId`を
   * 記録する。「同じSkillUse解決に属するイベントは同じ`skillUseId`を持つ」
   * （`08_ドメインイベント.md`）を`AppliedEffect`スコープのcounter更新でも
   * 満たすため。
   */
  private readonly skillUseIdOf = new Map<DomainEventId, SkillUseId>();
  /**
   * EFF-006/Issue #212: `R-EFF-11`の`EffectSequence`スコープ。`EffectSequence`
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
   * R-SKL-08（レビュー再指摘[P1]、PR #214）: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
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
  private readonly lastDamageResults: LastDamageResultRegistry = new Map();

  constructor(context: PassiveActivationRuntimeContext, initialUnits: readonly BattleUnit[]) {
    this.context = context;
    this.units = initialUnits;
    this.guard = createEmptyPassiveActivationGuard();
  }

  /** `action-skill-use-resolver.ts`/`action-charge-resolver.ts`が自身のEffectSequenceへも同じregistryを渡すための公開アクセサ。 */
  get lastDamageResultsRegistry(): LastDamageResultRegistry {
    return this.lastDamageResults;
  }

  get currentUnits(): readonly BattleUnit[] {
    return this.units;
  }

  /**
   * EFF-006/Issue #212: 呼び出し側（`action-skill-use-resolver.ts`のAS/EX、
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
    actorId: BattleUnitId,
    skillDefinitionId: SkillDefinitionId,
    counterUpdates: readonly RuntimeCounterUpdateDefinition[],
  ): void {
    this.activeEffectSequenceResolutions.set(skillUseId, {
      actorId,
      skillDefinitionId,
      counterUpdates,
    });
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
   * PR #211レビュー[P2]: `event`（原因イベント）が属するPSのSkillUseへ
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
          ...(this.context.resolutionPhase !== undefined
            ? { resolutionPhase: this.context.resolutionPhase }
            : {}),
        }),
      getCurrentUnit: (battleUnitId) => requireUnit(this.units, battleUnitId),
      // レビュー指摘[P2]: `getCurrentUnit`（`requireUnit`）は未知のBattleUnitIdに
      // 例外を送出するため、POSITION_RELATIONの対象不在を条件不成立として決定的に
      // 扱うR-PS-01/Issue #144の契約には使えない。対象解決専用に、見つからない
      // 場合`undefined`を返す`findUnit`を分けて渡す。
      findUnit: (battleUnitId) => this.units.find((unit) => unit.battleUnitId === battleUnitId),
      activate: (candidate, event): PassiveActivation =>
        this.activatePassiveCandidate(candidate, event),
      limits: this.context.limits ?? DEFAULT_PASSIVE_CHAIN_LIMITS,
      ...(this.context.resolutionPhase !== undefined
        ? { resolutionPhase: this.context.resolutionPhase }
        : {}),
      applyExpirationConditions: (event) => this.applyExpirationConditionsForChain(event),
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
   * `08_ドメインイベント.md`「イベント発行と処理」#3（M6最小実装、Issue #143）:
   * 原因イベントに起因する`RuntimeCounter`更新（`counterUpdates`、`SKILL_RUNTIME`
   * スコープ）を検出し、`RuntimeCounterChanged`を発行する。発行したイベントの
   * 候補解決は呼び出し側の責務とする（`state.guard`/stackを共有できるかどうかは
   * 呼び出し元のコンテキストに依存するため、ここではguardに触れない —
   * レビュー指摘[P1]参照）。
   *
   * レビュー指摘[P2]、レビュー再指摘[P2]、レビュー再々指摘[P2]: 同一原因
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
          // レビュー再々レビュー[P1]: `value`が変化していない（carryのみの
          // 変化の）更新でもこのイベント自体は発行する（追跡性のため）ので、
          // 閾値到達時だけ発動すべきPSはこのフィールドで絞り込む契約とする。
          valueChanged: change.valueChanged,
        },
        stateDelta: {
          units: {
            [change.ownerUnitId]: {
              // レビュー再々レビュー[P2]: `value`(公開値)が変化した場合だけ
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
                        // レビュー再々々レビュー[P1]: `captureBattleState`は
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
   * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-005/Issue #162、
   * PR #211レビュー[P1]で`onFactEvent`専用から`resolvePassiveChain`共通経路へ
   * 拡張）: `SkillRuntime`スコープの`detectAndRecordRuntimeCounterChanges`の
   * `AppliedEffect`スコープ版。`event`に一致する各効果インスタンス自身の
   * `duration.definition.counterUpdates`を検出し、`RuntimeCounterChanged`
   * （`scope: APPLIED_EFFECT`、`effectInstanceId`）を発行する。
   * `applyExpirationConditionsForChain`（R-EFF-08）より必ず先に呼ぶ — 更新後の
   * counter値をその評価が読めるようにする（R-EFF-11「原因イベントの状態変更
   * 確定後、PS/Memory候補抽出前にcounter更新を決定する」の同じ規則）。
   *
   * `onFactEvent`のトップレベル呼び出しと、`resolvePassiveChain`へ注入する
   * `deps.applyEffectRuntimeCounterUpdates`（PS自身がyieldする`PassiveActivated`・
   * `EffectActionStarting`、PS効果由来の`DamageApplied`等、`onFactEvent`を
   * 経由しないPS連鎖内部のイベントに同じ処理を届ける）の両方から呼ばれる。
   * `resolvePassiveChain`の最初の`resolveEvent(initialEvent, ...)`は`onFactEvent`
   * が渡すトップレベル`event`を再び処理するため、`processedEffectRuntimeCounterEventIds`
   * で同じ`DomainEventId`の二重処理を防ぐ（R-EFF-08の自然な冪等性とは異なり、
   * counter加算は同じeventに対して毎回マッチしうるため明示的なガードが必要）。
   *
   * レビュー再指摘[P1]: マッチした複数エントリを先にまとめて適用・記録してから
   * まとめて返すと、最初の`RuntimeCounterChanged`が誘発した候補解決（PSが
   * 後続のAppliedEffectを解除・変更しうる）より前に、後続エントリの`before`/
   * `after`が確定してしまう。`SkillRuntime`側の`detectAndRecordRuntimeCounterChanges`
   * と同じく、1件recordするたびに`resolveChild`（＝呼び出し元の候補解決、
   * トップレベルでは`onFactEvent`、PS連鎖内部では`resolveEvent`自身）を呼び、
   * その候補連鎖が完全に解決してから次のエントリを適用する。
   *
   * レビュー再指摘[P2]: `event`（原因イベント）が持つ`skillUseId`
   * （`skillUseIdOfCausingEvent`）を発行する`RuntimeCounterChanged`へそのまま
   * 継承する — 「同じSkillUse解決に属するイベントは同じ`skillUseId`を持つ」
   * （`08_ドメインイベント.md`）。原因イベントがトップレベル行動外イベント
   * （ターン開始・終了等）に由来する場合は`skillUseId`を持たないため省略する。
   *
   * `AppliedEffect`は`SkillRuntime`と異なり`resetScope: RESOLUTION_SCOPE`を
   * 持たない（効果インスタンス自身の失効がcounterの破棄を兼ねる）ため、
   * `RuntimeCounterReset`は発行しない。`stateDelta`は`skillCounters`のような
   * 専用キーを持たず、`EffectDurationReduced`等と同じ`effects[instanceId]`の
   * 完全なbefore/afterスナップショット差し替えを使う（`toEffectSnapshot`が
   * `counters`を含む値へ変換する）。`before`は`skillCounters`の「値0でも
   * キーを保持する」規約を流用せず、更新前の実際の`AppliedEffect`から
   * `toEffectSnapshot`で導出する — `effects`のstateDeltaは`sameEffectSnapshot`
   * による構造完全一致で検証される（`applyEffectDeltas`）ため、`counters`
   * キー自体の有無（`INCREMENT`の初回はキーが存在しない）を含めて実状態と
   * 厳密に一致させる必要がある（`skillCounterCarry`と同様、値の有無で
   * キーの有無も変わりうる）。
   *
   * PS連鎖内部から呼ばれる可能性があるため`this.onFactEvent`は呼ばない
   * （`applyExpirationConditionsForChain`と同じ制約）。自己再誘発の再帰depthは
   * 呼び出し元（PS連鎖内部では`resolve-passive-chain.ts`の
   * `ChainState.effectRuntimeCounterDepth`、トップレベルでは`onFactEvent`自身の
   * `counterUpdateDepth`）が管理する。
   */
  private applyEffectRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined {
    const eventId = this.eventIdOf(event);
    if (this.processedEffectRuntimeCounterEventIds.has(eventId)) {
      return undefined;
    }
    this.processedEffectRuntimeCounterEventIds.add(eventId);

    const matched = matchEffectRuntimeCounterUpdates(this.units, event);
    const causingSkillUseId = this.skillUseIdOfCausingEvent(event);
    for (const entry of matched) {
      const holderBefore = requireUnit(this.units, entry.battleUnitId);
      const effectBefore = holderBefore.appliedEffects.find(
        (effect) => effect.effectInstanceId === entry.effectInstanceId,
      );
      const result = applyMatchedEffectRuntimeCounterUpdate(entry, this.units, event);
      this.units = result.units;
      const change = result.change;
      if (change === undefined) {
        continue;
      }

      const holderAfter = requireUnit(this.units, change.battleUnitId);
      const effectAfter = holderAfter.appliedEffects.find(
        (effect) => effect.effectInstanceId === change.effectInstanceId,
      )!;
      const isEffective = selectEffectiveInstances(
        holderAfter.appliedEffects.map((effect) => ({
          effectInstanceId: effect.effectInstanceId,
          kindKey: effect.kindKey,
          duplicate: effect.duplicate,
          magnitude: effect.magnitude,
        })),
      ).has(change.effectInstanceId);
      const beforeSnapshot = toEffectSnapshot(effectBefore!, isEffective);
      const afterSnapshot = toEffectSnapshot(effectAfter, isEffective);

      const recorded = this.context.recorder.record({
        eventType: "RuntimeCounterChanged",
        category: "FACT",
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        ...(causingSkillUseId !== undefined ? { skillUseId: causingSkillUseId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: eventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: change.battleUnitId,
        payload: {
          ownerUnitId: change.battleUnitId,
          scope: "APPLIED_EFFECT",
          counter: change.counter,
          effectInstanceId: change.effectInstanceId,
          before: change.before,
          after: change.after,
          carry: change.carry,
          valueChanged: change.valueChanged,
        },
        stateDelta: {
          units: {
            [change.battleUnitId]: {
              effects: {
                [change.effectInstanceId]: {
                  before: beforeSnapshot,
                  after: afterSnapshot,
                },
              },
            },
          },
        },
      });

      const violation = resolveChild(recorded);
      if (violation !== undefined) {
        return violation;
      }
    }
    return undefined;
  }

  /**
   * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-006/Issue #212）:
   * `applyEffectRuntimeCounterUpdates`（`AppliedEffect`スコープ）の
   * `EffectSequence`スコープ版。`event`に一致する現在進行中の各EffectSequence
   * 解決（`this.activeEffectSequenceResolutions`）自身のcounterUpdatesを検出し、
   * `RuntimeCounterChanged`（`scope: EFFECT_SEQUENCE`、`skillDefinitionId`。
   * `SkillUseId`はイベントエンベロープの`skillUseId`が既に持つため`payload`には
   * 重複させない）を発行する。`applyExpirationConditionsForChain`（R-EFF-08）
   * より必ず先に呼ぶ（同じR-EFF-11の順序規則）。
   *
   * `onFactEvent`のトップレベル呼び出しと、`resolvePassiveChain`へ注入する
   * `deps.applyEffectSequenceRuntimeCounterUpdates`（PS自身がyieldする
   * `PassiveActivated`・`EffectActionStarting`等、`onFactEvent`を経由しない
   * PS連鎖内部のイベントに同じ処理を届ける）の両方から呼ばれる。
   * `processedEffectSequenceRuntimeCounterEventIds`で同じ`DomainEventId`の
   * 二重処理を防ぐ（`applyEffectRuntimeCounterUpdates`と同じ理由、別スコープの
   * ため独立したSetを使う）。
   *
   * マッチした複数エントリは1件ずつ`resolveChild`（候補連鎖の完全解決）を挟んで
   * 適用する（`applyEffectRuntimeCounterUpdates`と同じ理由）。
   */
  private applyEffectSequenceRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined {
    const eventId = this.eventIdOf(event);
    if (this.processedEffectSequenceRuntimeCounterEventIds.has(eventId)) {
      return undefined;
    }
    this.processedEffectSequenceRuntimeCounterEventIds.add(eventId);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      this.activeEffectSequenceResolutions,
      this.units,
      event,
    );
    for (const entry of matched) {
      const result = applyMatchedEffectSequenceRuntimeCounterUpdate(entry, this.units, event);
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
        skillUseId: change.skillUseId,
        resolutionScopeId: this.context.resolutionScopeId,
        parentEventId: eventId,
        rootEventId: this.context.rootEventId,
        sourceUnitId: change.actorId,
        payload: {
          ownerUnitId: change.actorId,
          scope: "EFFECT_SEQUENCE",
          counter: change.counter,
          skillDefinitionId: change.skillDefinitionId,
          before: change.before,
          after: change.after,
          carry: change.carry,
          valueChanged: change.valueChanged,
        },
        stateDelta: {
          units: {
            [change.actorId]: {
              ...(change.valueChanged
                ? {
                    effectSequenceCounters: {
                      [change.skillUseId]: {
                        [change.counter]: { before: change.before, after: change.after },
                      },
                    },
                  }
                : {}),
              ...(carryChanged
                ? {
                    effectSequenceCounterCarry: {
                      [change.skillUseId]: {
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

      const violation = resolveChild(recorded);
      if (violation !== undefined) {
        return violation;
      }
    }
    return undefined;
  }

  /**
   * EFF-006/Issue #212: `EffectSequence`は状態を持たないため、1回の解決が
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
    const actor = requireUnit(this.units, resolution.actorId);
    const counters = actor.effectSequenceCounters?.[skillUseId] ?? {};
    for (const counterId of Object.keys(counters) as (keyof typeof counters)[]) {
      const currentActor = requireUnit(this.units, resolution.actorId);
      const currentCounters = currentActor.effectSequenceCounters?.[skillUseId] ?? {};
      const result = resetRuntimeCounter(currentCounters, counterId);
      if (result === undefined) {
        continue;
      }
      const carryBefore = currentCounters[counterId]?.carry ?? 0;
      // レビュー指摘: `effectSequenceCounters`は`skillCounters`と異なり、この
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
        sourceUnitId: resolution.actorId,
        payload: {
          ownerUnitId: resolution.actorId,
          scope: "EFFECT_SEQUENCE",
          counter: counterId,
          skillDefinitionId: resolution.skillDefinitionId,
          before: result.change.before,
        },
        stateDelta: {
          units: {
            [resolution.actorId]: {
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
   * EFF-006/Issue #212: `finalizeEffectSequenceResolutionSteps`のトップレベル
   * 版。呼び出し側（AS/EX使用・チャージ解放）が、1つのEffectSequenceの解決
   * （`applyEffectActionGroups`の戻り）を受け取った直後に必ず1回呼ぶ。各
   * `RuntimeCounterReset`を`this.onFactEvent`へ再帰させ、その候補解決を
   * 完全に終えてから次のcounterへ進む（`finalizeResolutionScope`と同じ
   * トップレベル専用の駆動方法 — PS連鎖内部からはこのメソッドを呼んではならない、
   * 代わりに`finalizeEffectSequenceResolutionSteps`を`yield*`委譲すること）。
   */
  finalizeEffectSequenceResolution(skillUseId: SkillUseId): readonly BattleUnit[] {
    for (const recorded of this.finalizeEffectSequenceResolutionSteps(skillUseId)) {
      this.units = this.onFactEvent(recorded, this.units);
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
   * メソッド内で記録した発動をロストする（レビュー指摘[P1]、Issue #143）。
   * そのような文脈では代わりに`PassiveActivationStep`を`yield`し、進行中の
   * `driveActivation`が共有する`state`（guard/stack）へ正しく参加させること。
   */
  onFactEvent(
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
    counterUpdateDepth = 0,
  ): readonly BattleUnit[] {
    this.units = units;
    const triggerEvent = this.toTriggerEvent(event);

    const nextDepth = counterUpdateDepth + 1;
    for (const recorded of this.detectAndRecordRuntimeCounterChanges(event)) {
      if (nextDepth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds; a counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth);
    }

    // EFF-005/Issue #162（PR #211レビュー[P1]）: `AppliedEffect`スコープの
    // counter更新も、上の`SKILL_RUNTIME`スコープと同じくR-EFF-08
    // （`applyExpirationConditions`）より先に確定させる — 更新後の値をそのまま
    // `expiration.conditions`が読めるようにする（R-EFF-11の同じ規則）。
    // `applyEffectRuntimeCounterUpdates`自身が`processedEffectRuntimeCounterEventIds`
    // で二重処理を防ぐため、後続の`resolvePassiveChain`（`deps.
    // applyEffectRuntimeCounterUpdates`が同じ`triggerEvent`を再度処理しようと
    // しても）安全にno-opになる。`resolveChild`はこの再帰的`onFactEvent`
    // 呼び出し自体であり、record 1件ごとにその候補連鎖を完全に解決してから
    // 次のエントリへ進む（レビュー再指摘[P1]）。
    this.applyEffectRuntimeCounterUpdates(triggerEvent, (recorded) => {
      if (nextDepth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds; a DurationDefinition.counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth);
      return undefined;
    });

    // EFF-006/Issue #212: `EffectSequence`スコープも同じ理由・同じ順序
    // （`applyExpirationConditions`より先）で確定させる。
    this.applyEffectSequenceRuntimeCounterUpdates(triggerEvent, (recorded) => {
      if (nextDepth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
        throw new ExecutionGuardExceededError(
          `RuntimeCounterChanged self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds; an EffectSequence.counterUpdates definition likely re-triggers itself from the RuntimeCounterChanged event it causes (infinite regeneration)`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth);
      return undefined;
    });

    // レビュー指摘[P2]（PR #209）: R-EFF-08は「関連するドメインイベント発行後、
    // PS/Memory候補の抽出前に評価する」ことを要求する。`onFactEvent`はFACT/
    // TIMINGイベントの都度呼ばれる唯一の共通経路（`ActionCompleted`だけでなく
    // `DamageApplied`/`UnitDefeated`/`TurnCompleted`等すべて）のため、ここで
    // 評価すれば個別の呼び出し元ごとに配線し直す必要がない。失効で新たに
    // 発行された`EffectExpired`等も、この`event`自身のPS候補解決より前に
    // 自身のPS候補解決を終える（再帰depthは`RuntimeCounterChanged`と同じ
    // 上限を共有する）。
    this.units = this.applyExpirationConditions(event, nextDepth);

    // レビュー再指摘[P2]（PR #209）: 上記はトップレベルの`event`しかカバーせず、
    // PS連鎖の内部（`activatePassiveCandidate`が直接yieldする`PassiveActivated`・
    // `EffectActionStarting`等）は`onFactEvent`を経由しないため見落とされていた。
    // `resolvePassiveChain`（`resolve-passive-chain.ts`の`resolveEvent`）へ
    // `applyExpirationConditionsForChain`を`deps.applyExpirationConditions`として
    // 注入し、PS連鎖内部の各イベントに対しても候補抽出直前に同じ評価を行う。
    // トップレベルの`event`自身は上の呼び出しで既に失効済みのため、
    // `resolveEvent`側の評価は該当なし（no-op）になる — 二重発行はしない。
    const result = resolvePassiveChain(triggerEvent, this.guard, this.buildDependencies());
    if (!result.ok) {
      throw new ExecutionGuardExceededError(
        `PS chain resolution exceeded its execution guard: ${result.reason}`,
      );
    }
    this.guard = result.activationGuard;
    return this.units;
  }

  /**
   * R-EFF-08: `event`に対して`expiration.conditions`が成立した効果インスタンスを
   * 即時に失効させる（トップレベルの`onFactEvent`専用）。新たに発行された
   * イベント（`EffectExpired`・`CombatStatChanged`等）は`this.onFactEvent`へ
   * 再帰させ、`RuntimeCounterChanged`検出・自身の`expiration.conditions`評価・
   * PS候補解決を含めて完全に解決する（このメソッドは常にトップレベルの
   * `onFactEvent`から呼ばれ、進行中の`resolvePassiveChain`の内側からは呼ばれない
   * ため、新しい`resolvePassiveChain`呼び出しを起こしても安全）。
   */
  private applyExpirationConditions(
    event: BattleDomainEvent,
    depth: number,
  ): readonly BattleUnit[] {
    const matches = findEffectsMatchingExpirationCondition(this.units, event);
    if (matches.length === 0) {
      return this.units;
    }
    if (depth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
      throw new ExecutionGuardExceededError(
        `expiration.conditions self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds; an expiration.conditions definition likely re-triggers itself from the EffectExpired/CombatStatChanged event it causes (infinite regeneration)`,
      );
    }
    const seeds: ExpirationSeed[] = matches.map((match) => ({
      battleUnitId: match.battleUnitId,
      effectInstanceId: match.effectInstanceId,
      reason: "EXPIRATION_CONDITION",
    }));
    const eventsStart = this.context.recorder.getEvents().length;
    const expiry = expireEffects(
      {
        recorder: this.context.recorder,
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        rootEventId: this.context.rootEventId,
      },
      this.units,
      seeds,
      this.context.definitions.effectActions,
      event.eventId,
    );
    let units = expiry.units;
    for (const newEvent of this.context.recorder.getEvents().slice(eventsStart)) {
      units = this.onFactEvent(newEvent, units, depth);
    }
    return units;
  }

  /**
   * R-EFF-08: `event`に対して`expiration.conditions`が成立した効果インスタンスを
   * 即時に失効させ、新たに発行されたイベント（`EffectExpired`・
   * `CombatStatChanged`等）を`TriggerCandidateEvent`として返す。`resolveEvent`
   * （`triggering/resolve-passive-chain.ts`）が`deps.applyExpirationConditions`
   * として呼び出し、返されたイベントそれぞれを自身へ再帰させて候補解決する。
   * これは`applyExpirationConditions`（上記、トップレベルの`event`専用）を
   * 補完し、PS連鎖の内部（`activatePassiveCandidate`が直接yieldする
   * `PassiveActivated`・`EffectActionStarting`等、`onFactEvent`を経由しない
   * イベント）にも同じ評価を届ける。このメソッド自身は`this.onFactEvent`を
   * 呼ばない（進行中の`resolvePassiveChain`呼び出しの内側から呼ばれる可能性が
   * あり、新しい`resolvePassiveChain`を起こすと進行中のguard/stackを上書き
   * してしまうため、`onFactEvent`と同じ制約を持つ）。再帰depthは
   * `applyExpirationConditions`とは別の専用カウンタ
   * （`this.expirationConditionDepth`）で管理する。
   */
  private applyExpirationConditionsForChain(
    event: TriggerCandidateEvent,
  ): readonly TriggerCandidateEvent[] {
    const matches = findEffectsMatchingExpirationCondition(this.units, event);
    if (matches.length === 0) {
      return [];
    }
    this.expirationConditionDepth += 1;
    try {
      if (this.expirationConditionDepth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
        throw new ExecutionGuardExceededError(
          `expiration.conditions self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds; an expiration.conditions definition likely re-triggers itself from the EffectExpired/CombatStatChanged event it causes (infinite regeneration)`,
        );
      }
      const seeds: ExpirationSeed[] = matches.map((match) => ({
        battleUnitId: match.battleUnitId,
        effectInstanceId: match.effectInstanceId,
        reason: "EXPIRATION_CONDITION",
      }));
      const eventsStart = this.context.recorder.getEvents().length;
      const expiry = expireEffects(
        {
          recorder: this.context.recorder,
          turnNumber: this.context.turnNumber,
          cycleNumber: this.context.cycleNumber,
          ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
          resolutionScopeId: this.context.resolutionScopeId,
          rootEventId: this.context.rootEventId,
        },
        this.units,
        seeds,
        this.context.definitions.effectActions,
        this.eventIdOf(event),
      );
      this.units = expiry.units;
      return this.context.recorder
        .getEvents()
        .slice(eventsStart)
        .map((newEvent) => this.toTriggerEvent(newEvent));
    } finally {
      this.expirationConditionDepth -= 1;
    }
  }

  /**
   * `R-EFF-11`「解決スコープ終了時にリセットするcounter」（レビュー指摘[P2]、
   * Issue #143）。呼び出し側（`resolveSkillUse`／charge解放／`advanceBattle`の
   * `TurnStarted`処理など、このインスタンスが担当する1解決スコープを完全に終えた
   * 箇所）が、そのスコープ内の最後の`onFactEvent`呼び出し後に必ず1回呼び出す。
   * `resetScope: "RESOLUTION_SCOPE"`を宣言し現在値を持つcounterを破棄して
   * `RuntimeCounterReset`を発行し、その候補解決（`onFactEvent`経由、トップ
   * レベルの呼び出しのため安全）を行う。この候補解決が同じスコープへ新しい
   * 対象counterを生成・更新した場合は、リセット対象counterが残らなくなるまで
   * 「破棄→発行→候補解決」を繰り返す。対象12行はいずれも`resetScope`を宣言
   * しないため、この処理は常に即座に`this.units`をそのまま返す。
   *
   * レビュー指摘[P1]: `resetScope: RESOLUTION_SCOPE`のcounterが、自身の
   * `RuntimeCounterReset`をtriggerとする`counterUpdates`を持つ場合
   * （破棄→発行→その候補解決で同じcounterが即座に再生成される）、このwhileは
   * 決して`targets`が空にならず同期的に無限ループする。counter更新はPS発動
   * 済みGuard（`R-PS-07`）を通らないため、既存のPassiveChainLimitsもこの
   * ループ自体を止めない。反復回数の上限を設け、超過時は黙って打ち切る代わりに
   * 決定的なエラーとして検出する。
   */
  finalizeResolutionScope(): readonly BattleUnit[] {
    let round = 0;
    while (true) {
      const targets = collectResolutionScopeResets({
        units: this.units,
        unitDefinitions: this.context.definitions.unitDefinitions,
        skillDefinitions: this.context.definitions.skillDefinitions,
      });
      if (targets.length === 0) {
        return this.units;
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
        // レビュー再々レビュー[P2]: 破棄されるcarryもstateDeltaへ含めるため、
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
                    // レビュー指摘[P1]: `after: 0`ではなく`undefined`にして、
                    // 独立Reducerがキー自体を削除できるようにする（実状態の
                    // `resetRuntimeCounter`と同じく、値0で残すのではなく削除）。
                    [target.counter]: { before: result.change.before, after: undefined },
                  },
                },
                // レビュー再々レビュー[P2]: carryが実際に非0だった場合だけ
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
        this.units = this.onFactEvent(recorded, this.units);
      }
    }
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
    // レビュー指摘[P2]: PSも一つのSkillUse（`08_ドメインイベント.md`「同じ
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

    const exGain = increaseExGauge(this.units, ownerId, skill.cost.amount);
    this.units = exGain.units;
    lastEventId = recordResourceChangeIfAny(
      resourceCtx,
      ownerId,
      "EX_GAUGE",
      exGain.before,
      exGain.after,
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
        actorId: ownerId,
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
    // Issue #143修正 / レビュー指摘[P1]: `PassiveActivated`はこれまで直接record
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

    // R-PS-05 #5: EffectSequenceをR-SKL-01〜08に従って解決する。
    const plan = resolveSkillOrder(
      skill,
      ownerAfterChainedActivations,
      this.units,
      this.context.definitions.effectActions,
    );
    // Issue #34 (PR #141 review [P1]): ターン開始・終了など行動外の
    // トップレベルイベントから発動したPS（`actionId`を持たない）も実効果を
    // 解決できる。`EffectActionGroupContext`以下は`actionId`を任意にして
    // 素通しする。`EffectSequence.steps`はCatalog検証で非空のため、
    // `resolveEffectSequencePlan`は常に呼び出し、step単位のイベントを発行する
    // （#73: R-SKL-06）。
    //
    // PR #142レビュー[P1]: 以前は`applyEffectActionGroups`でplan全体を同期的に
    // 適用してから、記録された全イベントを一つの`EFFECT_RESOLVED`として
    // まとめてyieldしていた。そのため最初のEffectAction Aが子PSを誘発しても、
    // その子PSが解決される時点では後続EffectAction Bも適用済みになり
    // （「親A→子PS→親B」ではなく「親A→親B→子PS」）、R-PS-06の親処理復帰契約に
    // 反していた。`resolveEffectSequencePlan`（generator）へ`yield*`委譲する
    // ことで、`resolvePassiveChain`の`driveActivation`が管理する共有state
    // （PassiveResolutionStack・深度Guard・効果解決数Guard）へ正しく参加し、
    // 各EffectAction/step境界で子PS連鎖を完全に解決してから次へ進むように
    // なる。
    const groupContext: EffectActionGroupContext = {
      definitions: this.context.definitions,
      actorId: ownerId,
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
      lastDamageResults: this.lastDamageResults,
    };
    // EFF-006/Issue #212: このPS自身のEffectSequence解決を開始する前に登録する
    // （`SkillUseStarting`相当のTIMINGはPSには無いため、`resolveEffectSequencePlan`
    // 自身が発行する最初のイベントから対象にできるようにする）。
    this.beginEffectSequenceResolution(
      skillUseId,
      ownerId,
      skill.skillDefinitionId,
      skill.resolution.counterUpdates ?? [],
    );
    const box: UnitsBox = { units: this.units };
    const generator = resolveEffectSequencePlan(plan, box, groupContext);
    let step = generator.next();
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
      step = generator.next();
    }
    this.units = box.units;
    const effectResult = step.value;
    const interruptedCount = effectResult.interruptedCount;
    const sequenceInterrupted = effectResult.sequenceInterrupted;

    // EFF-006/Issue #212: このPS自身のEffectSequence解決が完了した時点で、
    // そのcounterを直ちに破棄する（`resolveEffectSequencePlan`が中断で終わった
    // 場合も含め、必ず1回だけ呼ぶ）。PS連鎖内部（このgenerator自身が
    // `driveActivation`に駆動されている）から呼んでいるため、
    // `finalizeEffectSequenceResolution`（トップレベル専用、内部で
    // `this.onFactEvent`を再帰させる）ではなく、`finalizeEffectSequenceResolutionSteps`
    // を`yield*`委譲し、`driveActivation`が共有するstateへ正しく候補解決させる。
    for (const recorded of this.finalizeEffectSequenceResolutionSteps(skillUseId)) {
      yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(recorded) };
      lastEventId = recorded.eventId;
    }

    // R-PS-05 #6 / R-SKL-01: 使用者(PS所有者)が戦闘不能になり、未解決のまま
    // 打ち切られた適用が実際に残った場合だけ中断とする（PR #141再レビュー[P2]:
    // 戦闘不能かどうかだけでは判定しない — 最後の効果で倒れても残り0件なら
    // 正常解決のまま）。PR #216再々々々々々レビュー[P1]:
    // `effectResult.sequenceInterrupted`（resolverが中断を検出したまさに
    // その箇所で確定する正式なフラグ）で判定し、見積もりである
    // `interruptedCount`の大小には依存しない。
    const interrupted = sequenceInterrupted;
    const resolvedStepCount =
      skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps.length : 0;
    let terminalEvent: BattleDomainEvent;
    if (interrupted) {
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
          unresolvedEffectCount: interruptedCount,
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
    // レビュー指摘[P1]: `PassiveActivated`と同じ理由（544行目付近）で、
    // `PassiveResolved`/`PassiveInterrupted`もPS発動契機にできる契約
    // （08_ドメインイベント.md「同じSkillUseIdに属するイベント」節、
    // 「味方のPS解決後」を条件とするPS等）を満たすため、TIMING_EVENTとして
    // yieldし進行中の`driveActivation`が共有するstateへ候補解決させる。
    const terminalCounterChanges = this.detectAndRecordRuntimeCounterChanges(
      terminalEvent,
      skillUseId,
    );
    for (const changed of terminalCounterChanges) {
      yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(changed) };
    }
    yield { kind: "TIMING_EVENT", event: this.toTriggerEvent(terminalEvent) };

    return { interrupted };
  }
}
