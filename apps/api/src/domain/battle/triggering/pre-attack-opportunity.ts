import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import { sortPassiveCandidates } from "./passive-candidate-order.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/** 攻撃前観測1件ぶんの候補検出結果（同時発動制限は未適用）。 */
export interface PreAttackObservationCandidates {
  readonly event: TriggerCandidateEvent;
  readonly candidates: PassiveCandidateGroup;
}

export interface AggregatedPreAttackCandidates {
  readonly candidates: PassiveCandidateGroup;
  readonly triggerEventOf: ReadonlyMap<PassiveCandidate, TriggerCandidateEvent>;
}

/**
 * R-ATM-03: 1回の攻撃スキル使用について、全対象の攻撃前観測の候補を1つの発動機会へ
 * 集約する。同じ`BattleUnitId + SkillDefinitionId`が複数の対象に一致した場合は、
 * 観測の発行順で最初に一致した対象の候補だけを残し、その観測を契機イベントにする。
 * 集約後はR-PS-02/R-PS-08の順に並べ直す — 後の対象にだけ一致する速い候補も、
 * 先の対象に一致した遅い候補より先に処理される。
 */
export function aggregatePreAttackCandidates(
  observations: readonly PreAttackObservationCandidates[],
): AggregatedPreAttackCandidates {
  const seen = new Set<string>();
  const candidates: PassiveCandidate[] = [];
  const triggerEventOf = new Map<PassiveCandidate, TriggerCandidateEvent>();
  for (const observation of observations) {
    for (const candidate of observation.candidates) {
      const key = `${candidate.unit.battleUnitId}::${candidate.skillDefinition.skillDefinitionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(candidate);
      triggerEventOf.set(candidate, observation.event);
    }
  }
  return { candidates: sortPassiveCandidates(candidates), triggerEventOf };
}
