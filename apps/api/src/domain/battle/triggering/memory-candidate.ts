import type { MemoryDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { TriggeredEffect } from "../../catalog/definitions/memory-definition.js";
import type { Side } from "../../shared/side.js";

/**
 * `05_ドメインモデル.md`「Memory triggeredEffects 解決」/ R-MEM-01「条件を満たした
 * triggeredEffectを同じイベントのMemory候補グループにする」の候補1件分。
 *
 * PS候補（{@link ./passive-candidate.ts}）と異なり所有ユニットを持たない —
 * R-MEM-04「使用者はMemoryを指定した陣営を source side とする」により、発動の
 * 主体は`side`（そのMemoryを編成に指定した陣営）である。`memoryIndex`は
 * R-MEM-02 #1「APIリクエストで指定された Memory の順序」、
 * `triggeredEffectIndex`は同 #2「同一 Memory 内の `triggeredEffects` 定義順」の
 * 比較キー。
 */
export interface MemoryCandidate {
  readonly side: Side;
  readonly memoryDefinitionId: MemoryDefinitionId;
  readonly memoryIndex: number;
  readonly triggeredEffectIndex: number;
  readonly triggeredEffect: TriggeredEffect;
}

/** R-MEM-01 #4「条件を満たした triggeredEffect を同じイベントのMemory候補グループにする」の結果。 */
export type MemoryCandidateGroup = readonly MemoryCandidate[];
