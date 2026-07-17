import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";

export interface SimultaneousActivationLimitResult {
  readonly kept: PassiveCandidateGroup;
  readonly suppressed: PassiveCandidateGroup;
}

/**
 * R-PS-03「同時発動制限」+ `14_Catalog定義スキーマ.md`の`exclusiveActivationGroupId`
 * （同タイミング排他グループ）: `group`は`sortPassiveCandidates`済み（R-PS-02/R-PS-08
 * 順）であることを前提とし、各制約グループ（`simultaneousActivationLimited`は
 * イベント内で一つの暗黙グループ、`exclusiveActivationGroupId`は値ごとに独立した
 * グループ）で先頭（最上位）の候補だけを残す。両方の制約を同時に持つ候補が
 * 敗れた場合も`suppressed`には一度だけ現れる。除外されたPSは発動済みとして
 * 記録しない（R-PS-03「除外されたPSは発動済みとして記録しない」）。
 */
export function applySimultaneousActivationLimit(
  group: PassiveCandidateGroup,
): SimultaneousActivationLimitResult {
  const suppressedIndexes = new Set<number>();

  const limitedIndexes = group.reduce<number[]>((indexes, candidate, index) => {
    if (candidate.skillDefinition.traits.simultaneousActivationLimited) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  for (const index of limitedIndexes.slice(1)) {
    suppressedIndexes.add(index);
  }

  const firstIndexByExclusiveGroupId = new Map<string, number>();
  group.forEach((candidate, index) => {
    const exclusiveGroupId = candidate.skillDefinition.traits.exclusiveActivationGroupId;
    if (exclusiveGroupId === null) {
      return;
    }
    if (firstIndexByExclusiveGroupId.has(exclusiveGroupId)) {
      suppressedIndexes.add(index);
    } else {
      firstIndexByExclusiveGroupId.set(exclusiveGroupId, index);
    }
  });

  const kept: PassiveCandidate[] = [];
  const suppressed: PassiveCandidate[] = [];
  group.forEach((candidate, index) => {
    (suppressedIndexes.has(index) ? suppressed : kept).push(candidate);
  });
  return { kept, suppressed };
}
