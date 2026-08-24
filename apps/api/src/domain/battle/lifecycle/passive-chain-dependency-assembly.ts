import { requireUnit } from "./action-resolution-shared.js";
import { detectPassiveCandidates } from "../triggering/passive-trigger-matcher.js";
import { detectMemoryCandidates } from "../triggering/memory-trigger-matcher.js";
import { NO_MEMORIES, type BattleDefinitions } from "../model/battle-definitions.js";
import type {
  ActivateMemoryCandidate,
  ActivatePassiveCandidate,
  PassiveChainDependencies,
} from "../triggering/resolve-passive-chain.js";
import type { PassiveActivationGuard } from "../triggering/passive-activation-guard.js";
import type {
  PassiveChainLimits,
  PassiveChainLimitViolationReason,
} from "../model/passive-chain-limits.js";
import type { MemoryCandidate } from "../triggering/memory-candidate.js";
import type { TriggerCandidateEvent } from "../triggering/trigger-event.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";

/**
 * `PassiveActivationRuntime.buildDependencies()`が`PassiveChainDependencies`を
 * 組み立てるために必要とする、Runtime側の状態・メソッドへのアクセス。
 * `activatePassiveCandidate`/`reconfirmMemoryCandidate`/`activateMemoryCandidate`
 * （PS/Memory発動連鎖そのもの）や`applyExpirationConditionsForChain`等
 * （REF-063 #1/#2で抽出済みの協力オブジェクトへの薄い委譲）はRuntime側の
 * 責務のまま残るため、コールバックとして注入する。
 */
export interface PassiveChainDependencySource {
  getUnits(): readonly BattleUnit[];
  getGuard(): PassiveActivationGuard;
  readonly definitions: BattleDefinitions;
  readonly turnNumber: number;
  readonly resolutionPhase?: ResolutionPhase;
  readonly limits: PassiveChainLimits;
  activatePassiveCandidate: ActivatePassiveCandidate;
  reconfirmMemoryCandidate(candidate: MemoryCandidate, event: TriggerCandidateEvent): boolean;
  activateMemoryCandidate: ActivateMemoryCandidate;
  applyExpirationConditionsForChain(event: TriggerCandidateEvent): readonly TriggerCandidateEvent[];
  applyMarkerSourceDefeatRemovalsForChain(
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined;
  applyEffectRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined;
  applyEffectSequenceRuntimeCounterUpdates(
    event: TriggerCandidateEvent,
    resolveChild: (recorded: BattleDomainEvent) => PassiveChainLimitViolationReason | undefined,
  ): PassiveChainLimitViolationReason | undefined;
  toTriggerEvent(event: BattleDomainEvent): TriggerCandidateEvent;
}

/**
 * `resolvePassiveChain`/`resolvePendingCandidateGroups`（`triggering/resolve-passive-chain.ts`）
 * へ注入する`PassiveChainDependencies`を、`PassiveActivationRuntime`が1解決
 * スコープぶん保持する状態から組み立てる。呼び出しの都度（イベントごとに）
 * 再構築する既存の運用に合わせ、この関数自体も副作用を持たない純粋な組み立て
 * 専用処理として切り出した（REF-063 #3）。
 */
export function buildPassiveChainDependencies(
  source: PassiveChainDependencySource,
): PassiveChainDependencies {
  return {
    detectCandidates: (event) =>
      detectPassiveCandidates({
        event,
        units: source.getUnits(),
        unitDefinitions: source.definitions.unitDefinitions,
        skillDefinitions: source.definitions.skillDefinitions,
        activationGuard: source.getGuard(),
        turnNumber: source.turnNumber,
        ...(source.resolutionPhase !== undefined
          ? { resolutionPhase: source.resolutionPhase }
          : {}),
      }),
    getCurrentUnit: (battleUnitId) => requireUnit(source.getUnits(), battleUnitId),
    // `getCurrentUnit`（`requireUnit`）は未知のBattleUnitIdに
    // 例外を送出するため、POSITION_RELATIONの対象不在を条件不成立として決定的に
    // 扱うR-PS-01の契約には使えない。対象解決専用に、見つからない
    // 場合`undefined`を返す`findUnit`を分けて渡す。
    findUnit: (battleUnitId) =>
      source.getUnits().find((unit) => unit.battleUnitId === battleUnitId),
    activate: source.activatePassiveCandidate,
    // R-MEM-01/02（M7-006）: 同じイベントのMemory候補。PS候補と同じ
    // `resolvePassiveChain`のスタックへ乗せ、PS候補を使い切った後に解決させる。
    detectMemoryCandidates: (event) =>
      detectMemoryCandidates({
        event,
        units: source.getUnits(),
        memoriesBySide: source.definitions.memoriesBySide ?? NO_MEMORIES,
        ...(source.resolutionPhase !== undefined
          ? { resolutionPhase: source.resolutionPhase }
          : {}),
        turnNumber: source.turnNumber,
      }),
    reconfirmMemoryCandidate: (candidate, event) =>
      source.reconfirmMemoryCandidate(candidate, event),
    activateMemory: source.activateMemoryCandidate,
    limits: source.limits,
    turnNumber: source.turnNumber,
    // RES-004: `ALIVE_UNIT_COUNT`の再確認（R-PS-04）が候補検出時と
    // 同じ生存数母集団を使うため、`findUnit`と同様に`units`を都度読み直す
    // 関数として渡す（PS連鎖の途中で`units`が変わりうるため固定配列は使えない）。
    getAllUnits: () => source.getUnits(),
    // M7-001E: `TARGET_STATE`の`UNIT_TYPE`/`ROLE`（`SKL_CHIYURU_MAZE_PS2`／
    // `SKL_LUCIE_MAID_PS1`のtrigger条件）を、再確認（R-PS-04）でも候補検出時と
    // 同じCatalog参照表で評価する。
    unitDefinitions: source.definitions.unitDefinitions,
    ...(source.resolutionPhase !== undefined ? { resolutionPhase: source.resolutionPhase } : {}),
    applyExpirationConditions: (event) => source.applyExpirationConditionsForChain(event),
    // M7-020: R-EFF-08と同じく「関連するドメインイベント発行後、
    // PS/Memory候補の抽出前」に評価する独立した機構。`resolveEvent`側では
    // `applyExpirationConditions`の直後に呼ばれる（トップレベルの`onFactEvent`と
    // 同じ順序）。イベント配列を返す形ではなく`resolveChild`形をとる
    // （R-EFF-09の逐次通知契約を満たすため）。
    applyMarkerSourceDefeatRemovals: (event, resolveChild) =>
      source.applyMarkerSourceDefeatRemovalsForChain(event, resolveChild),
    applyEffectRuntimeCounterUpdates: (event, resolveChild) =>
      source.applyEffectRuntimeCounterUpdates(event, (recorded) =>
        resolveChild(source.toTriggerEvent(recorded)),
      ),
    applyEffectSequenceRuntimeCounterUpdates: (event, resolveChild) =>
      source.applyEffectSequenceRuntimeCounterUpdates(event, (recorded) =>
        resolveChild(source.toTriggerEvent(recorded)),
      ),
  };
}
