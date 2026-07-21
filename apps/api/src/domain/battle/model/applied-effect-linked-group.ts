import type { BattleUnit } from "./battle-unit.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";

/**
 * R-EFF-09「linkedEffectGroup」: 同じ`linkedEffectGroupId`を持つ`AppliedEffect`は
 * 親子連動グループとして扱う。`seedExpiredInstanceIds`（既に失効・解除が確定した
 * インスタンス）から、同じグループへ属する未失効インスタンスをすべて収集する
 * （BFS）。グループは`linkedEffectGroupId`という値だけで識別され、どのユニットの
 * `appliedEffects`に保持されているかは問わない — グループは特定ユニットへ
 * 閉じない（`14_Catalog定義スキーマ.md`のスキーマ自体にユニット単位の制約が
 * ない）。呼び出し側（`duration-expiry-service.ts`）が、この結果集合から
 * 「子を先に、親を最後に」失効イベントを順序付けて発行する。
 */
export function collectLinkedGroupCascade(
  units: readonly BattleUnit[],
  seedExpiredInstanceIds: ReadonlySet<EffectInstanceId>,
): ReadonlySet<EffectInstanceId> {
  const groupIdByInstanceId = new Map<EffectInstanceId, string>();
  const instanceIdsByGroupId = new Map<string, EffectInstanceId[]>();
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const groupId = effect.duration.definition.linkedEffectGroupId;
      if (groupId === null) {
        continue;
      }
      groupIdByInstanceId.set(effect.effectInstanceId, groupId);
      const bucket = instanceIdsByGroupId.get(groupId);
      if (bucket === undefined) {
        instanceIdsByGroupId.set(groupId, [effect.effectInstanceId]);
      } else {
        bucket.push(effect.effectInstanceId);
      }
    }
  }

  const result = new Set<EffectInstanceId>(seedExpiredInstanceIds);
  const queue = [...seedExpiredInstanceIds];
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
