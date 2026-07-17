import { compareActionOrder } from "../action/action-order-policy.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";

/**
 * R-PS-08「先制攻撃特性を持つPSを通常のPS候補より先に処理する」+ R-PS-02
 * 「所有者の現在行動速度：降順 / 味方陣営、敵陣営 / 前列、後列 / 絶対左、中央、右 /
 * 同じユニットではPS定義順」。先制攻撃かどうかで2つのバケットへ分け、各バケット内
 * を`compareActionOrder`（`battle/action`のR-ORD-02比較器、行動速度・陣営・行・列
 * まで同じキーを使う）で並べ、最後に同一Unit内のPS定義順で決着させる。
 */
export function comparePassiveCandidates(a: PassiveCandidate, b: PassiveCandidate): number {
  const bucketA = a.skillDefinition.traits.priorityAttack ? 0 : 1;
  const bucketB = b.skillDefinition.traits.priorityAttack ? 0 : 1;
  if (bucketA !== bucketB) {
    return bucketA - bucketB;
  }
  const actionOrder = compareActionOrder(a.unit, b.unit);
  if (actionOrder !== 0) {
    return actionOrder;
  }
  return a.definitionIndex - b.definitionIndex;
}

/** R-PS-01 #4/R-PS-02: 入力配列順に依存しない候補グループを返す。入力配列は変更しない。 */
export function sortPassiveCandidates(
  candidates: readonly PassiveCandidate[],
): PassiveCandidateGroup {
  return [...candidates].sort(comparePassiveCandidates);
}
