import type { BattleUnit } from "./battle-unit.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { LinkedEffectGroupRole } from "../../catalog/definitions/duration-definition.js";

/**
 * R-EFF-09「linkedEffectGroup」: 同じ`linkedEffectGroupId`を持つ`AppliedEffect`は
 * 親子連動グループとして扱う。`seedExpiredInstanceIds`（既に失効・解除が確定した
 * インスタンス）から、同じグループへ属する未失効インスタンスをすべて収集する
 * （BFS）。グループは`linkedEffectGroupId`という値だけで識別され、どのユニットの
 * `appliedEffects`に保持されているかは問わない — グループは特定ユニットへ
 * 閉じない（`14_Catalog定義スキーマ.md`のスキーマ自体にユニット単位の制約が
 * ない）。呼び出し側（`duration-expiry-service.ts`）が、この結果集合から
 * 「子を先に、親を最後に」失効イベントを順序付けて発行する。
 *
 * レビュー再指摘[P2]（PR #209）: `linkedEffectGroupRole`（`PARENT`/`CHILD`）を
 * 明示するメンバーがいるグループでは、カスケードの起点を`CHILD`ロールの
 * seedからは起こさない（R-EFF-09「子効果だけが消費条件で失効した場合、親効果は
 * 維持する」— 失効理由ではなく明示的な親子関係で判定する）。`PARENT`ロールの
 * seed（または`linkedEffectGroupId`のみでロールを持たないレガシーな
 * seed）は、理由を問わず同グループ全体へカスケードする。一度カスケードが
 * 到達したグループ内では、そこから先の（`CHILD`経由の）伝播はグループが
 * 既に完全に閉じているため実質no-opであり、追加のロール判定は不要。
 */
export function collectLinkedGroupCascade(
  units: readonly BattleUnit[],
  seedExpiredInstanceIds: ReadonlySet<EffectInstanceId>,
): ReadonlySet<EffectInstanceId> {
  const groupIdByInstanceId = new Map<EffectInstanceId, string>();
  const instanceIdsByGroupId = new Map<string, EffectInstanceId[]>();
  const roleByInstanceId = new Map<EffectInstanceId, LinkedEffectGroupRole | undefined>();
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const groupId = effect.duration.definition.linkedEffectGroupId;
      if (groupId === null) {
        continue;
      }
      groupIdByInstanceId.set(effect.effectInstanceId, groupId);
      roleByInstanceId.set(
        effect.effectInstanceId,
        effect.duration.definition.linkedEffectGroupRole,
      );
      const bucket = instanceIdsByGroupId.get(groupId);
      if (bucket === undefined) {
        instanceIdsByGroupId.set(groupId, [effect.effectInstanceId]);
      } else {
        bucket.push(effect.effectInstanceId);
      }
    }
  }

  const result = new Set<EffectInstanceId>(seedExpiredInstanceIds);
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
