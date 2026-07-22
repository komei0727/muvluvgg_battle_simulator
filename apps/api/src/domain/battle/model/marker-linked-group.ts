import type { BattleUnit } from "./battle-unit.js";
import type { MarkerInstanceId } from "../../shared/event-ids.js";
import type { LinkedEffectGroupRole } from "../../catalog/definitions/duration-definition.js";

/**
 * `applied-effect-linked-group.ts`の`collectLinkedGroupCascade`と同じ規則
 * （R-EFF-09）を`MarkerState`同士に適用する。R-EFF-09が明示する
 * 「同じ`linkedEffectGroupId`を持つ`AppliedEffect`と`MarkerState`は親子連動
 * グループとして扱う」のうち、`AppliedEffect`と`MarkerState`をまたぐカスケード
 * （`duration-expiry-service.ts`側の`expireEffects`との相互配線）は未実装のため、
 * `catalog-integrity.ts`の`validateEffectAction`が`APPLY_MARKER.duration.
 * linkedEffectGroupId`を非nullにするproduction定義をCatalogロード時点で明示的に
 * 拒否する（`UNSUPPORTED_MARKER_LINKED_GROUP`、PR #210レビュー[P2]）。対応が
 * 完成するまでMarkerが`AppliedEffect`とlinkedEffectGroupを共有する定義自体が
 * preflightを通過しないため、この関数は`MarkerState`同士の対称なカスケードだけを
 * 扱えばよい。
 */
export function collectMarkerLinkedGroupCascade(
  units: readonly BattleUnit[],
  seedExpiredInstanceIds: ReadonlySet<MarkerInstanceId>,
): ReadonlySet<MarkerInstanceId> {
  const groupIdByInstanceId = new Map<MarkerInstanceId, string>();
  const instanceIdsByGroupId = new Map<string, MarkerInstanceId[]>();
  const roleByInstanceId = new Map<MarkerInstanceId, LinkedEffectGroupRole | undefined>();
  for (const unit of units) {
    for (const marker of unit.markerStates) {
      const groupId = marker.duration.definition.linkedEffectGroupId;
      if (groupId === null) {
        continue;
      }
      groupIdByInstanceId.set(marker.markerInstanceId, groupId);
      roleByInstanceId.set(
        marker.markerInstanceId,
        marker.duration.definition.linkedEffectGroupRole,
      );
      const bucket = instanceIdsByGroupId.get(groupId);
      if (bucket === undefined) {
        instanceIdsByGroupId.set(groupId, [marker.markerInstanceId]);
      } else {
        bucket.push(marker.markerInstanceId);
      }
    }
  }

  const result = new Set<MarkerInstanceId>(seedExpiredInstanceIds);
  const queue = [...seedExpiredInstanceIds].filter(
    (instanceId) => roleByInstanceId.get(instanceId) !== "CHILD",
  );
  while (queue.length > 0) {
    const instanceId = queue.shift()!;
    const groupId = groupIdByInstanceId.get(instanceId);
    if (groupId === undefined) {
      continue;
    }
    for (const siblingId of instanceIdsByGroupId.get(groupId) ?? []) {
      if (!result.has(siblingId)) {
        result.add(siblingId);
        queue.push(siblingId);
      }
    }
  }
  return result;
}
