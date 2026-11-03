import type { ComparisonOperator } from "./catalog-enums.js";

/**
 * `TARGET_HAS_MARKER.countCondition`と`MARKER_COUNT_CONDITION`フィルタが共有する
 * スタック数の比較。`condition-definition.ts`と`target-selector-definition.ts`が
 * 互いを参照すると循環するため、両者から独立した場所に置く。
 */
export interface MarkerCountCondition {
  readonly op: ComparisonOperator;
  readonly value: number;
}
