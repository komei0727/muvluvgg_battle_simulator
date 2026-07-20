// docs/ui-design/07_UI実装・拡張計画.md §10 (M6 PSイベントエンジン拡張):
// 「event parent/root sequenceのtree表示」「parent/root sequenceの欠番を許容
// する」。全eventはenvelope上の`parentSequence`（`08_ドメインイベント.md`
// 「子イベントのsequenceは親イベントより大きくする」）で連結されるため、
// PS/Memoryに限らずどのevent typeにも同じ機構でtreeを構築する。これにより、
// 将来Memory発動eventが追加された際もこのmoduleの変更なしに追跡可能になる。
//
// `parentSequence`が指す親が現在のevents[]に存在しない場合（SUMMARYログで
// 親だけが除外された等）でも、そのeventはroot levelへ落として保持する
// （UI-CMP-006「100件超のイベントも黙って切り捨てない」と同じ「削除しない」
// 方針）。

import type { BattleLogEventResponse } from "../simulation/api-contract.js";

export interface CausalityTreeNode {
  readonly event: BattleLogEventResponse;
  readonly sequence: number;
  readonly children: readonly CausalityTreeNode[];
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

interface MutableNode {
  readonly event: BattleLogEventResponse;
  readonly sequence: number;
  readonly children: MutableNode[];
}

export function buildCausalityTree(
  events: readonly BattleLogEventResponse[],
): readonly CausalityTreeNode[] {
  const sorted = [...events].sort(
    (a, b) => (numberOf(a["sequence"]) ?? 0) - (numberOf(b["sequence"]) ?? 0),
  );

  const nodeBySequence = new Map<number, MutableNode>();
  const roots: MutableNode[] = [];

  for (const event of sorted) {
    const sequence = numberOf(event["sequence"]) ?? 0;
    const node: MutableNode = { event, sequence, children: [] };
    nodeBySequence.set(sequence, node);

    const parentSequence = numberOf(event["parentSequence"]);
    const parent = parentSequence !== undefined ? nodeBySequence.get(parentSequence) : undefined;
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
