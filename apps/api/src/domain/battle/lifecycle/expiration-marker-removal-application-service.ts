import { findEffectsMatchingExpirationCondition } from "./effect-expiration-condition-service.js";
import { findMarkersRemovedOnSourceDefeat } from "./marker-source-defeat-service.js";
import { expireEffects, type ExpirationSeed } from "../effects/duration-expiry-service.js";
import { removeMarkers, removeMarkersSteps } from "../effects/marker-removal-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";
import type { PassiveChainLimitViolationReason } from "../model/passive-chain-limits.js";
import type { ActionId, DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";

/**
 * `applyExpirationConditions`/`applyMarkerSourceDefeatRemovals`（トップレベル）と
 * その`ForChain`版が発行するイベントに共通する因果関係コンテキスト。
 * `PassiveActivationRuntime`が1解決スコープぶん保持するenvelope値をそのまま渡す。
 */
export interface ExpirationMarkerRemovalContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * `applyExpirationConditionsForChain`/`applyMarkerSourceDefeatRemovalsForChain`が
 * 共有する自己再誘発の再帰深度（R-EFF-08の`expiration.conditions`カスケードと
 * R-EFF-10の`removeOnSourceDefeated`は独立した別の自己再誘発経路だが、
 * `RuntimeCounterChanged`の再帰とも独立した専用カウンタを1つ共有する——元実装の
 * `PassiveActivationRuntime.expirationConditionDepth`と同じ役割）。呼び出し元が
 * 1解決スコープにつき1つ保持し、両関数呼び出しへそのまま渡す。
 */
export interface ChainExpirationDepthState {
  depth: number;
}

function toExpireEffectsContext(
  context: ExpirationMarkerRemovalContext,
  onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[],
) {
  return {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    rootEventId: context.rootEventId,
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
  };
}

/**
 * R-EFF-08: `event`に対して`expiration.conditions`が成立した効果インスタンスを
 * 即時に失効させる（トップレベルの`onFactEvent`専用）。新たに発行された
 * イベント（`EffectExpired`・`CombatStatChanged`等）は`onFactEventForPassiveChain`
 * （呼び出し元の`onFactEvent`再帰）へ渡し、`RuntimeCounterChanged`検出・自身の
 * `expiration.conditions`評価・PS候補解決を含めて完全に解決させる（この関数は
 * 常にトップレベルの`onFactEvent`から呼ばれ、進行中の`resolvePassiveChain`の
 * 内側からは呼ばれないため、`onFactEventForPassiveChain`が新しい
 * `resolvePassiveChain`呼び出しを起こしても安全）。
 */
export function applyExpirationConditions(
  context: ExpirationMarkerRemovalContext,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  units: readonly BattleUnit[],
  event: BattleDomainEvent,
  depth: number,
  maxEffectRuntimeCounterDepth: number,
  onFactEventForPassiveChain: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[],
): readonly BattleUnit[] {
  const matches = findEffectsMatchingExpirationCondition(units, event);
  if (matches.length === 0) {
    return units;
  }
  if (depth > maxEffectRuntimeCounterDepth) {
    throw new ExecutionGuardExceededError(
      `expiration.conditions self-triggering recursion exceeded ${maxEffectRuntimeCounterDepth} rounds; an expiration.conditions definition likely re-triggers itself from the EffectExpired/CombatStatChanged event it causes (infinite regeneration)`,
    );
  }
  const seeds: ExpirationSeed[] = matches.map((match) => ({
    battleUnitId: match.battleUnitId,
    effectInstanceId: match.effectInstanceId,
    reason: "EXPIRATION_CONDITION",
  }));
  // 通知は`expireEffects`が1インスタンスの失効ごとに行う
  // （R-EFF-09カスケードで巻き込まれた子効果・子Markerを含む）。ここでまとめて
  // 通知すると、子の`EffectExpired`をtriggerにするPSが親の除去済み状態を見る。
  const expiry = expireEffects(
    toExpireEffectsContext(context, onFactEventForPassiveChain),
    units,
    seeds,
    effectActions,
    event.eventId,
  );
  return expiry.units;
}

/**
 * R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020）: `event`が
 * `UnitDefeated`のとき、`duration.removeOnSourceDefeated`を宣言し付与者が
 * その戦闘不能ユニットであるMarkerを即時に解除する（トップレベルの
 * `onFactEvent`専用、`applyExpirationConditions`と同じ形・同じ制約）。
 *
 * 解除は`removeMarkers`へ流し込むため、同じ`linkedEffectGroupId`を持つ子効果は
 * R-EFF-09のcross-typeカスケードが自動で巻き込む（`ACT_AOI_ELEGANT_AS1_KOUYOU_
 * CRIT_DOWN`／`..._DOT`）。`onFactEventForPassiveChain`を渡すことで、1インスタンス
 * の除去ごとに（カスケード分もseed分も）PS/Memoryの即時連鎖へ通知する
 * （R-EFF-09）。
 */
export function applyMarkerSourceDefeatRemovals(
  context: ExpirationMarkerRemovalContext,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  units: readonly BattleUnit[],
  event: BattleDomainEvent,
  depth: number,
  maxEffectRuntimeCounterDepth: number,
  onFactEventForPassiveChain: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[],
): readonly BattleUnit[] {
  const seeds = findMarkersRemovedOnSourceDefeat(units, event);
  if (seeds.length === 0) {
    return units;
  }
  if (depth > maxEffectRuntimeCounterDepth) {
    throw new ExecutionGuardExceededError(
      `removeOnSourceDefeated self-triggering recursion exceeded ${maxEffectRuntimeCounterDepth} rounds; a Marker removal likely re-triggers a UnitDefeated observation (infinite regeneration)`,
    );
  }
  const removal = removeMarkers(
    toExpireEffectsContext(context, onFactEventForPassiveChain),
    units,
    seeds,
    effectActions,
    event.eventId,
  );
  return removal.units;
}

export interface ChainExpirationConditionsResult {
  readonly units: readonly BattleUnit[];
  readonly events: readonly TriggerCandidateEvent[];
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
 * イベント）にも同じ評価を届ける。この関数自身は`onFactEvent`を呼ばない
 * （進行中の`resolvePassiveChain`呼び出しの内側から呼ばれる可能性が
 * あり、新しい`resolvePassiveChain`を起こすと進行中のguard/stackを上書き
 * してしまうため）。再帰depthは`applyExpirationConditions`とは別の専用カウンタ
 * （`chainDepth`）で管理する。
 *
 * `expireEffects`をこの解決の全seedへ一括で1回だけ適用してから戻る——
 * 呼び出し元（`resolveEvent`）が返り値の各イベントを自身へ再帰させて候補解決を
 * 完全に終えるのは、この関数から戻った後の責務である。
 */
export function applyExpirationConditionsForChain(
  context: ExpirationMarkerRemovalContext,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  chainDepth: ChainExpirationDepthState,
  maxEffectRuntimeCounterDepth: number,
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
  eventId: DomainEventId,
  toTriggerEvent: (event: BattleDomainEvent) => TriggerCandidateEvent,
): ChainExpirationConditionsResult {
  const matches = findEffectsMatchingExpirationCondition(units, event);
  if (matches.length === 0) {
    return { units, events: [] };
  }
  chainDepth.depth += 1;
  try {
    if (chainDepth.depth > maxEffectRuntimeCounterDepth) {
      throw new ExecutionGuardExceededError(
        `expiration.conditions self-triggering recursion exceeded ${maxEffectRuntimeCounterDepth} rounds; an expiration.conditions definition likely re-triggers itself from the EffectExpired/CombatStatChanged event it causes (infinite regeneration)`,
      );
    }
    const seeds: ExpirationSeed[] = matches.map((match) => ({
      battleUnitId: match.battleUnitId,
      effectInstanceId: match.effectInstanceId,
      reason: "EXPIRATION_CONDITION",
    }));
    const eventsStart = context.recorder.getEvents().length;
    const expiry = expireEffects(
      toExpireEffectsContext(context),
      units,
      seeds,
      effectActions,
      eventId,
    );
    return {
      units: expiry.units,
      events: context.recorder.getEvents().slice(eventsStart).map(toTriggerEvent),
    };
  } finally {
    chainDepth.depth -= 1;
  }
}

/**
 * R-EFF-10（M7-020）: `applyMarkerSourceDefeatRemovals`の
 * PS連鎖内部版。`applyExpirationConditionsForChain`と同じ理由で必要になる —
 * PSのEffectSequenceが与えたダメージによる`UnitDefeated`は`onFactEvent`を
 * 経由しないため（`UT-R-EFF-11-017`と同じ経路）、トップレベル側の配線だけでは
 * 「PSがとどめを刺した付与者のMarkerが解除されない」取りこぼしになる
 * （`UT-R-EFF-10-033`が固定）。
 *
 * `applyExpirationConditionsForChain`のように「全メンバーを
 * 除去してからイベント配列を返す」形にはできない。Marker解除はR-EFF-09の
 * カスケードでlinked group全体を巻き込むため、その形では最初の子`EffectExpired`
 * をPS/Memoryへ渡す時点で親Markerが既に消えており、R-EFF-09「各インスタンスの
 * 失効イベントは次のインスタンスへ進む前にPS/Memoryの即時連鎖へ渡す」に反する
 * （親Markerを条件にするPS/Memoryが、同じ`UnitDefeated`でもトップレベル経路では
 * 発動しこの経路では発動しない差を生む。`UT-R-EFF-10-034`が固定）。
 * `removeMarkersSteps`を1メンバーずつ駆動し、各ステップのイベントを
 * `resolveChild`（＝`resolveEvent`自身への再帰、進行中のguard/stackを維持する）で
 * 完全に解決してから`.next()`で次のメンバーへ進む。`onFactEvent`は呼ばない
 * （`applyExpirationConditionsForChain`と同じ制約）。
 *
 * `resolveChild`（`resolve-passive-chain.ts`側の既存契約）は解決後の`units`を
 * 明示的な戻り値として渡さないため、`getUnits`/`setUnits`で呼び出し元
 * （`PassiveActivationRuntime`）の最新状態を都度読み書きする——`resolveChild`が
 * 及ぼす副作用を、次のステップの起点として読み直す必要があるため。
 */
export function applyMarkerSourceDefeatRemovalsForChain(
  context: ExpirationMarkerRemovalContext,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  chainDepth: ChainExpirationDepthState,
  maxEffectRuntimeCounterDepth: number,
  getUnits: () => readonly BattleUnit[],
  setUnits: (units: readonly BattleUnit[]) => void,
  toTriggerEvent: (event: BattleDomainEvent) => TriggerCandidateEvent,
  event: TriggerCandidateEvent,
  eventId: DomainEventId,
  resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
): PassiveChainLimitViolationReason | undefined {
  const seeds = findMarkersRemovedOnSourceDefeat(getUnits(), event);
  if (seeds.length === 0) {
    return undefined;
  }
  chainDepth.depth += 1;
  try {
    if (chainDepth.depth > maxEffectRuntimeCounterDepth) {
      throw new ExecutionGuardExceededError(
        `removeOnSourceDefeated self-triggering recursion exceeded ${maxEffectRuntimeCounterDepth} rounds; a Marker removal likely re-triggers a UnitDefeated observation (infinite regeneration)`,
      );
    }
    const steps = removeMarkersSteps(
      toExpireEffectsContext(context),
      getUnits(),
      seeds,
      effectActions,
      eventId,
    );
    let step = steps.next();
    while (!step.done) {
      // このステップ分の除去は`this.units`へ即時反映してから候補解決へ渡す
      // （解決中のPS/Memoryが最新の状態を観測できるようにする）。
      setUnits(step.value.units);
      for (const recorded of step.value.events) {
        const violation = resolveChild(toTriggerEvent(recorded));
        if (violation !== undefined) {
          return violation;
        }
      }
      // 候補解決が`this.units`を書き換えた分を次のステップの起点へ注入する。
      step = steps.next(getUnits());
    }
    setUnits(step.value.units);
    return undefined;
  } finally {
    chainDepth.depth -= 1;
  }
}
