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
import { applyEffectConsumptionAndExpiration } from "./effect-reactive-lifecycle.js";
import { resolveSkillOrder } from "../skill/skill-resolution-service.js";
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
import { resetRuntimeCounter } from "../model/runtime-counter-state.js";
import {
  createEmptyPassiveActivationGuard,
  type PassiveActivationGuard,
} from "../triggering/passive-activation-guard.js";
import type { PassiveChainLimits } from "../triggering/passive-chain-limits.js";
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
 * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の暫定既定値。
 * M9で設定可能にするまでの固定値（`13_実装計画.md`「実行保護の全上限を設定
 * 可能にする」）。
 */
export const DEFAULT_PASSIVE_CHAIN_LIMITS: PassiveChainLimits = {
  maxPassiveDepth: 8,
  maxEffectsPerScope: 50,
};

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
 */
const MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH = 10;

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

  constructor(context: PassiveActivationRuntimeContext, initialUnits: readonly BattleUnit[]) {
    this.context = context;
    this.units = initialUnits;
    this.guard = createEmptyPassiveActivationGuard();
  }

  get currentUnits(): readonly BattleUnit[] {
    return this.units;
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

    // PR #155レビュー[P1] (R-EFF-07/08): 原因イベント確定直後・PS/Memory候補
    // 抽出前に、消費条件・特殊失効条件を`RuntimeCounterChanged`と同じタイミングで
    // 評価する。ここで発行された`EffectExpired`/`EffectConsumptionChanged`/
    // `EffectiveEffectChanged`/`MarkerRemoved`自体もPS/Memoryの発動契機に
    // できる契約（`EffectApplied`等と同様）のため、再帰的に`onFactEvent`へ渡す。
    const reactiveResult = applyEffectConsumptionAndExpiration(
      {
        recorder: this.context.recorder,
        turnNumber: this.context.turnNumber,
        cycleNumber: this.context.cycleNumber,
        ...(this.context.actionId !== undefined ? { actionId: this.context.actionId } : {}),
        resolutionScopeId: this.context.resolutionScopeId,
        rootEventId: this.context.rootEventId,
      },
      this.units,
      event,
      event.eventId,
    );
    this.units = reactiveResult.units;
    for (const recorded of reactiveResult.events) {
      if (nextDepth > MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH) {
        throw new ExecutionGuardExceededError(
          `EffectExpired/EffectConsumptionChanged self-triggering recursion exceeded ${MAX_RUNTIME_COUNTER_UPDATE_RECURSION_DEPTH} rounds`,
        );
      }
      this.units = this.onFactEvent(recorded, this.units, nextDepth);
    }

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
    };
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

    // R-PS-05 #6 / R-SKL-01: 使用者(PS所有者)が戦闘不能になり、未解決のまま
    // 打ち切られた適用が実際に残った場合だけ中断とする（PR #141再レビュー[P2]:
    // 戦闘不能かどうかだけでは判定しない — 最後の効果で倒れても残り0件なら
    // 正常解決のまま）。
    const interrupted = interruptedCount > 0;
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
