import { effectActionFrom } from "../fixtures/index.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";

/**
 * `REMOVE_EFFECTS` 定義が宣言する解除条件の正規形（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `maxRemovals` は**欠落を `null` へ写す** — 実行結果だけでは「上限が無い」と
 * 「上限がたまたま投入件数と同じ」が区別できないため（前提を4件置いて4件解除
 * されるだけの観測は `maxRemovals: 4` を足しても通る）。`toEqual` の完全一致で
 * 数値の混入を落とせるようにする。
 */
export interface RemovalDeclaration {
  readonly categories: readonly string[];
  readonly maxRemovals: number | null;
}

export function removalDeclarationOf(
  snapshot: BattleCatalogSnapshot,
  effectActionDefinitionId: string,
): RemovalDeclaration {
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  if (definition.kind !== "REMOVE_EFFECTS") {
    throw new Error(
      `"${effectActionDefinitionId}" is a ${definition.kind}, not a REMOVE_EFFECTS definition`,
    );
  }
  return {
    categories: [...definition.payload.categories],
    maxRemovals: definition.payload.maxRemovals ?? null,
  };
}
