import { isCoolingDown } from "../action/action-selection-policy.js";
import { isDefeated, isFrozen, isStunned, type BattleUnit } from "../model/battle-unit.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { PassiveActivationGuard } from "./passive-activation-guard.js";
import { hasActivated } from "./passive-activation-guard.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/**
 * R-PS-04で候補が破棄される理由。`12_テスト戦略.md`「再確認」が要求する
 * 「発動直前確認で候補が除外され、適切な診断理由を観測できること」を満たすため、
 * `PassiveCandidateSuppressed`（M6のイベント追加候補、実際の発行は#21以降）へ
 * そのまま転記できる粒度にする。
 */
export type PassiveReconfirmationReason =
  | "OWNER_DEFEATED"
  | "OWNER_CHARGING"
  | "OWNER_STUNNED"
  | "OWNER_FROZEN"
  | "INSUFFICIENT_PP"
  | "COOLING_DOWN"
  | "CONDITION_NOT_MET"
  | "ALREADY_ACTIVATED";

export type PassiveReconfirmationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PassiveReconfirmationReason };

/**
 * R-PS-04「発動直前確認」: 候補検出後にネストしたイベントで状態が変わりうるため、
 * 発動直前に次を再確認する。所有者が戦闘可能／気絶・凍結中でない（R-STS-02/03、
 * Issue #180）／チャージ中でない／PPを保有／クールタイムが0／
 * `trigger.condition`と`skillDefinition.activationCondition`が現在も成立／
 * 現在の解決スコープで未発動。いずれかを満たさなくなった候補は
 * `{ ok: false, reason }`を返す（呼び出し側が理由を観測したうえで破棄する）。
 * `currentUnit`は候補検出時点のスナップショットではなく、再確認時点の最新状態を
 * 渡す。`getUnit`/`resolutionPhase`は`POSITION_RELATION`/`RESOLUTION_PHASE`
 * （Issue #144）を候補検出時と同一の文脈で再評価するために、呼び出し側
 * （`resolve-passive-chain.ts`の`PassiveChainDependencies`）が候補検出時と
 * 同じ値を渡す。`units`/`turnNumber`（RES-004、Issue #171）も同じ理由で
 * `ALIVE_UNIT_COUNT`/`TURN_NUMBER`を候補検出時と同一の文脈で再評価するために
 * 渡す。`units`は再確認時点の最新状態（呼び出し側が`currentUnit`と同様に
 * 都度渡す）。`unitDefinitions`（M7-001E、Issue #248）も同じ理由で、
 * `TARGET_STATE`の`UNIT_TYPE`/`ROLE`を候補検出時と同じCatalog参照表で
 * 再評価するために渡す。
 */
export function reconfirmPassiveCandidate(
  candidate: PassiveCandidate,
  currentUnit: BattleUnit,
  event: TriggerCandidateEvent,
  activationGuard: PassiveActivationGuard,
  getUnit?: (battleUnitId: BattleUnitId) => BattleUnit | undefined,
  resolutionPhase?: ResolutionPhase,
  units?: readonly BattleUnit[],
  turnNumber?: number,
  unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): PassiveReconfirmationResult {
  if (isDefeated(currentUnit)) {
    return { ok: false, reason: "OWNER_DEFEATED" };
  }
  // R-STS-02/R-STS-03「AS、PS、EXスキルを新たに使用できない／使用できない」:
  // 気絶・凍結中の所有者はPSを新規発動できない。
  if (isStunned(currentUnit)) {
    return { ok: false, reason: "OWNER_STUNNED" };
  }
  if (isFrozen(currentUnit)) {
    return { ok: false, reason: "OWNER_FROZEN" };
  }
  if (currentUnit.charge !== undefined) {
    return { ok: false, reason: "OWNER_CHARGING" };
  }
  if (currentUnit.currentPp < candidate.skillDefinition.cost.amount) {
    return { ok: false, reason: "INSUFFICIENT_PP" };
  }
  if (isCoolingDown(currentUnit, candidate.skillDefinition.skillDefinitionId)) {
    return { ok: false, reason: "COOLING_DOWN" };
  }
  const counterContext = {
    owner: currentUnit,
    skillDefinitionId: candidate.skillDefinition.skillDefinitionId,
    ...(getUnit !== undefined ? { getUnit } : {}),
    ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
    ...(units !== undefined ? { units } : {}),
    ...(turnNumber !== undefined ? { turnNumber } : {}),
    ...(unitDefinitions !== undefined ? { unitDefinitions } : {}),
  };
  if (
    !evaluateTriggerCondition(candidate.trigger.condition, event, counterContext) ||
    !evaluateTriggerCondition(candidate.skillDefinition.activationCondition, event, counterContext)
  ) {
    return { ok: false, reason: "CONDITION_NOT_MET" };
  }
  if (
    hasActivated(
      activationGuard,
      currentUnit.battleUnitId,
      candidate.skillDefinition.skillDefinitionId,
    )
  ) {
    return { ok: false, reason: "ALREADY_ACTIVATED" };
  }
  return { ok: true };
}
