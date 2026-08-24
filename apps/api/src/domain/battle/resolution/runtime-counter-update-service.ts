import { requireUnit } from "./action-resolution-shared.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";
import type { PassiveChainLimitViolationReason } from "../model/passive-chain-limits.js";
import {
  applyMatchedEffectRuntimeCounterUpdate,
  matchEffectRuntimeCounterUpdates,
} from "../triggering/runtime-counter-effect-matcher.js";
import {
  applyMatchedEffectSequenceRuntimeCounterUpdate,
  matchEffectSequenceRuntimeCounterUpdates,
  type ActiveEffectSequenceResolution,
} from "../triggering/effect-sequence-runtime-counter-matcher.js";

/**
 * `applyEffectRuntimeCounterUpdates`/`applyEffectSequenceRuntimeCounterUpdates`が
 * 発行する`RuntimeCounterChanged`に共通する因果関係コンテキスト。
 * `PassiveActivationRuntime`が1解決スコープぶん保持するenvelope値をそのまま渡す。
 *
 * `getUnits`/`setUnits`は`this.units`（呼び出し元が1解決スコープぶん保持する
 * 最新state）への読み書きを外側から行うためのアクセサ。`resolveChild`（呼び出し元の
 * `resolvePassiveChain`／`onFactEvent`への再帰）はunitsを明示的な戻り値として
 * 受け渡さない既存契約（`PassiveChainDependencies.applyEffectRuntimeCounterUpdates`）
 * のため、複数エントリを1件ずつ「units反映→record→(呼び出し側の)候補解決」する
 * このモジュールの内部ループは、`resolveChild`が及ぼす`this.units`への副作用を
 * 次のエントリの起点として読み直す必要がある。関数を純粋に保てないのはこの外部契約
 * （`resolve-passive-chain.ts`側、本モジュールのスコープ外）に起因する。
 */
export interface RuntimeCounterUpdateContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  getUnits(): readonly BattleUnit[];
  setUnits(units: readonly BattleUnit[]): void;
}

/**
 * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-005。`onFactEvent`専用から
 * `resolvePassiveChain`共通経路へ拡張）: `SkillRuntime`スコープの
 * `RuntimeCounterChanged`検出の`AppliedEffect`スコープ版。`event`に一致する各効果
 * インスタンス自身の`duration.definition.counterUpdates`を検出し、`RuntimeCounterChanged`
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
 * が渡すトップレベル`event`を再び処理するため、`processedEventIds`
 * で同じ`DomainEventId`の二重処理を防ぐ（R-EFF-08の自然な冪等性とは異なり、
 * counter加算は同じeventに対して毎回マッチしうるため明示的なガードが必要）。
 *
 * マッチした複数エントリを先にまとめて適用・記録してから
 * まとめて返すと、最初の`RuntimeCounterChanged`が誘発した候補解決（PSが
 * 後続のAppliedEffectを解除・変更しうる）より前に、後続エントリの`before`/
 * `after`が確定してしまう。1件recordするたびに`resolveChild`（＝呼び出し元の
 * 候補解決、トップレベルでは`onFactEvent`、PS連鎖内部では`resolveEvent`自身）を
 * 呼び、その候補連鎖が完全に解決してから次のエントリを適用する。
 *
 * `causingSkillUseId`（呼び出し元の`skillUseIdOfCausingEvent(event)`）を発行する
 * `RuntimeCounterChanged`へそのまま継承する — 「同じSkillUse解決に属するイベントは
 * 同じ`skillUseId`を持つ」（`08_ドメインイベント.md`）。原因イベントがトップレベル
 * 行動外イベント（ターン開始・終了等）に由来する場合は`skillUseId`を持たないため
 * `undefined`になる。
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
 * PS連鎖内部から呼ばれる可能性があるため呼び出し元の`onFactEvent`は呼ばない
 * （`applyExpirationConditionsForChain`と同じ制約）。自己再誘発の再帰depthは
 * 呼び出し元（PS連鎖内部では`resolve-passive-chain.ts`の
 * `ChainState.effectRuntimeCounterDepth`、トップレベルでは`onFactEvent`自身の
 * `counterUpdateDepth`）が管理する。
 */
export function applyEffectRuntimeCounterUpdates(
  context: RuntimeCounterUpdateContext,
  processedEventIds: Set<DomainEventId>,
  event: TriggerCandidateEvent,
  eventId: DomainEventId,
  causingSkillUseId: SkillUseId | undefined,
  resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
): PassiveChainLimitViolationReason | undefined {
  if (processedEventIds.has(eventId)) {
    return undefined;
  }
  processedEventIds.add(eventId);

  const matched = matchEffectRuntimeCounterUpdates(context.getUnits(), event);
  for (const entry of matched) {
    const holderBefore = requireUnit(context.getUnits(), entry.battleUnitId);
    const effectBefore = holderBefore.appliedEffects.find(
      (effect) => effect.effectInstanceId === entry.effectInstanceId,
    );
    const result = applyMatchedEffectRuntimeCounterUpdate(entry, context.getUnits(), event);
    context.setUnits(result.units);
    const change = result.change;
    if (change === undefined) {
      continue;
    }

    const holderAfter = requireUnit(context.getUnits(), change.battleUnitId);
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

    const recorded = context.recorder.record({
      eventType: "RuntimeCounterChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(causingSkillUseId !== undefined ? { skillUseId: causingSkillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: eventId,
      rootEventId: context.rootEventId,
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
 * `08_ドメインイベント.md`「イベント発行と処理」#3（EFF-006）:
 * `applyEffectRuntimeCounterUpdates`（`AppliedEffect`スコープ）の
 * `EffectSequence`スコープ版。`event`に一致する現在進行中の各EffectSequence
 * 解決（`activeEffectSequenceResolutions`）自身のcounterUpdatesを検出し、
 * `RuntimeCounterChanged`（`scope: EFFECT_SEQUENCE`、`skillDefinitionId`。
 * `SkillUseId`はイベントエンベロープの`skillUseId`が既に持つため`payload`には
 * 重複させない）を発行する。`applyExpirationConditionsForChain`（R-EFF-08）
 * より必ず先に呼ぶ（同じR-EFF-11の順序規則）。
 *
 * `onFactEvent`のトップレベル呼び出しと、`resolvePassiveChain`へ注入する
 * `deps.applyEffectSequenceRuntimeCounterUpdates`（PS自身がyieldする
 * `PassiveActivated`・`EffectActionStarting`等、`onFactEvent`を経由しない
 * PS連鎖内部のイベントに同じ処理を届ける）の両方から呼ばれる。
 * `processedEventIds`で同じ`DomainEventId`の二重処理を防ぐ
 * （`applyEffectRuntimeCounterUpdates`と同じ理由、別スコープのため
 * 呼び出し元が独立したSetを渡す）。
 *
 * マッチした複数エントリは1件ずつ`resolveChild`（候補連鎖の完全解決）を挟んで
 * 適用する（`applyEffectRuntimeCounterUpdates`と同じ理由）。
 *
 * `activeEffectSequenceResolutions`の登録・削除（`beginEffectSequenceResolution`／
 * `finalizeEffectSequenceResolution(Steps)`）は呼び出し元（解決スコープの
 * ライフサイクル管理）の責務であり、本関数は読み取り専用でこのMapを参照する。
 */
export function applyEffectSequenceRuntimeCounterUpdates(
  context: RuntimeCounterUpdateContext,
  processedEventIds: Set<DomainEventId>,
  activeEffectSequenceResolutions: ReadonlyMap<SkillUseId, ActiveEffectSequenceResolution>,
  event: TriggerCandidateEvent,
  eventId: DomainEventId,
  resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
): PassiveChainLimitViolationReason | undefined {
  if (processedEventIds.has(eventId)) {
    return undefined;
  }
  processedEventIds.add(eventId);

  const matched = matchEffectSequenceRuntimeCounterUpdates(
    activeEffectSequenceResolutions,
    context.getUnits(),
    event,
  );
  for (const entry of matched) {
    const result = applyMatchedEffectSequenceRuntimeCounterUpdate(entry, context.getUnits(), event);
    context.setUnits(result.units);
    const change = result.change;
    if (change === undefined) {
      continue;
    }

    const carryChanged = change.carry !== change.carryBefore;
    const recorded = context.recorder.record({
      eventType: "RuntimeCounterChanged",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: change.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: change.actorUnitId,
      payload: {
        ownerUnitId: change.actorUnitId,
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
          [change.actorUnitId]: {
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
