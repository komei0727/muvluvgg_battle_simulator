import { combineEffects, type StatEffect } from "./effect-stacking-policy.js";
import type { Percentage } from "../../shared/percentage.js";

export interface CombatStatInput {
  readonly baseValue: number;
  /** 編成補正 (`FormationBonus` から対象ステータス分だけ取り出したもの)。 */
  readonly formationBonus: Percentage;
  /** 適性補正 (`PositionAptitudePolicy.resolveAptitudePenalty` の結果)。 */
  readonly aptitudePenalty: Percentage;
  /** 戦闘中割合補正の元になるバフ・デバフ (`EffectStackingPolicy`へ渡す)。 */
  readonly ratioEffects: readonly StatEffect[];
  /** 固定値補正の合計 (`APPLY_STAT_MOD` の `valueType: FIXED` 由来)。 */
  readonly fixedCorrection: number;
}

/**
 * R-STA-01: 戦闘中ステータス = 基本値 × (1 + 編成補正 − 適性補正) × (1 + 戦闘中割合補正) + 固定値補正。
 * R-STA-04: バフ・デバフや条件の変化後は同じ純粋関数を新しい`ratioEffects`で呼び直すだけで再計算できる。
 */
export function calculateCombatStat(input: CombatStatInput): number {
  const ratioCorrection = combineEffects(input.ratioEffects);
  return (
    input.baseValue * (1 + input.formationBonus - input.aptitudePenalty) * (1 + ratioCorrection) +
    input.fixedCorrection
  );
}
