import { isCoolingDown } from "../action/action-selection-policy.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { PassiveActivationGuard } from "./passive-activation-guard.js";
import { hasActivated } from "./passive-activation-guard.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/**
 * R-PS-04「発動直前確認」: 候補検出後にネストしたイベントで状態が変わりうるため、
 * 発動直前に次を再確認する。所有者が戦闘可能／チャージ中でない／PPを保有／
 * クールタイムが0／発動条件が現在も成立／現在の解決スコープで未発動。いずれかを
 * 満たさなくなった候補はfalseを返す（呼び出し側が破棄する）。`currentUnit`は
 * 候補検出時点のスナップショットではなく、再確認時点の最新状態を渡す。
 */
export function reconfirmPassiveCandidate(
  candidate: PassiveCandidate,
  currentUnit: BattleUnit,
  event: TriggerCandidateEvent,
  activationGuard: PassiveActivationGuard,
): boolean {
  if (isDefeated(currentUnit)) {
    return false;
  }
  if (currentUnit.charge !== undefined) {
    return false;
  }
  if (currentUnit.currentPp < candidate.skillDefinition.cost.amount) {
    return false;
  }
  if (isCoolingDown(currentUnit, candidate.skillDefinition.skillDefinitionId)) {
    return false;
  }
  if (!evaluateTriggerCondition(candidate.trigger.condition, event)) {
    return false;
  }
  if (
    hasActivated(
      activationGuard,
      currentUnit.battleUnitId,
      candidate.skillDefinition.skillDefinitionId,
    )
  ) {
    return false;
  }
  return true;
}
