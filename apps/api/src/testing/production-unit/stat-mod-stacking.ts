import { computeCombatStats } from "../../domain/battle/effects/combat-stat-recalculation-service.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import { applyPrecedingActions, productionBoard, type BoardOverrides } from "./skill-behaviour.js";

/**
 * `Q-CAT-EFF-16`（raw原文が「重複可」を付けないバフは重複なし）を実 `catalog/` の
 * `APPLY_STAT_MOD` 定義に対して観測するための入力。
 */
export interface RepeatedStatModGrantOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly unitDefinitionId: string;
  readonly effectActionDefinitionId: string;
  /** 前提アクションの向き。`ALLY` は自身以外の味方単体、`ENEMY` は敵単体へ解決する。 */
  readonly target: "SELF" | "ALLY" | "ENEMY";
  /** 観測する戦闘中ステータス（`CombatStats` のフィールド名）。 */
  readonly stat: keyof CombatStats;
  /** 付与回数。既定の2回で「2件目が積み増すか」を見る。 */
  readonly grants?: number;
  readonly board?: BoardOverrides;
}

export interface RepeatedStatModGrantResult {
  /** 保持者が実際に保持しているインスタンス数（`NON_STACKABLE` でも減らない）。 */
  readonly instanceCount: number;
  /** 補正前の基準値（`baseCombatStats`）。 */
  readonly baseValue: number;
  /** R-STA-03の同種選択を通した合成後の実効値。 */
  readonly effectiveValue: number;
}

/**
 * 同じ EffectAction を `grants` 回付与し、保持者の実効ステータスを返す。
 *
 * `NON_STACKABLE` は付与そのものを止めるのではなく合成側で同種（`EffectKindKey`）
 * グループの最強1件だけを選ぶ規則（R-EFF-05）であるため、「重複しないこと」は
 * インスタンス数ではなく `computeCombatStats` を通した実効値でしか観測できない。
 * `computeCombatStats` は純粋関数で、常に `baseCombatStats` から合成し直す。
 */
export function repeatedStatModGrant(
  options: RepeatedStatModGrantOptions,
): RepeatedStatModGrantResult {
  const grants = options.grants ?? 2;
  const board = productionBoard(options.snapshot, options.unitDefinitionId, options.board);
  const units = applyPrecedingActions(
    board,
    Array.from({ length: grants }, () => ({
      effectActionDefinitionId: options.effectActionDefinitionId,
      target: options.target,
    })),
  );

  const holder = holderOf(units, options.effectActionDefinitionId);
  return {
    instanceCount: holder.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === options.effectActionDefinitionId,
    ).length,
    baseValue: holder.baseCombatStats[options.stat],
    effectiveValue: computeCombatStats(holder, board.definitions.effectActions).combatStats[
      options.stat
    ],
  };
}

function holderOf(units: readonly BattleUnit[], effectActionDefinitionId: string): BattleUnit {
  const holder = units.find((unit) =>
    unit.appliedEffects.some(
      (effect) => effect.effectActionDefinitionId === effectActionDefinitionId,
    ),
  );
  if (holder === undefined) {
    throw new Error(`no unit on the board holds "${effectActionDefinitionId}"`);
  }
  return holder;
}
