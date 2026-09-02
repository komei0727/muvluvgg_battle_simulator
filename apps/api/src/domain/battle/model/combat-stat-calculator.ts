import { combineEffects, type StatEffect } from "./effect-stacking-policy.js";
import { isPointAdditiveStat, type StatKind } from "../../catalog/definitions/catalog-enums.js";
import type { Percentage } from "../../shared/percentage.js";

export interface CombatStatInput {
  /** R-STA-01: どちらの式で合成するかは対象ステータスだけで決まる（`POINT_ADDITIVE_STAT_KINDS`）。 */
  readonly stat: StatKind;
  readonly baseValue: number;
  /** 編成補正 (`FormationBonus` から対象ステータス分だけ取り出したもの)。 */
  readonly formationBonus: Percentage;
  /** 適性補正 (`PositionAptitudePolicy.resolveAptitudePenalty` の結果)。 */
  readonly aptitudePenalty: Percentage;
  /** 戦闘中補正の元になるバフ・デバフ (`EffectStackingPolicy`へ渡す)。 */
  readonly ratioEffects: readonly StatEffect[];
  /** 固定値補正の合計 (`APPLY_STAT_MOD` の `valueType: FIXED` 由来)。 */
  readonly fixedCorrection: number;
  /**
   * 戦闘中割合補正（`ratioEffects`）が乗算される基準値。省略時は`baseValue`を使う
   * （既存の全呼び出し元と数学的に同一）。R-TEX-04でブレイク強化を受けた戦術演習の
   * 敵ユニットだけが、書き換え後の`baseValue`とは別にこれを渡し、戦闘中割合補正の
   * 増減量を戦闘開始時の原基準値（Break0）基準に固定する。
   */
  readonly ratioEffectBaseValue?: number;
}

/**
 * R-STA-01: 対象ステータスの分類で式が分かれる。
 *
 * - 割合補正ステータス（HP・攻撃力・防御力・行動速度）:
 *   `基本値 × (1 + 編成補正 − 適性補正) × (1 + 戦闘中割合補正) + 固定値補正`
 * - パーセントポイント加算ステータス（会心率・会心ダメージボーナス・属性相性ボーナス）:
 *   `基本値 + 編成補正 + 戦闘中補正 + 固定値補正`
 *
 * R-STA-04: バフ・デバフや条件の変化後は同じ純粋関数を新しい`ratioEffects`で呼び直すだけで再計算できる。
 */
export function calculateCombatStat(input: CombatStatInput): number {
  const combinedEffects = combineEffects(input.ratioEffects);
  if (isPointAdditiveStat(input.stat)) {
    // 適性補正はR-STA-01でHP・攻撃力・防御力だけが受けるため、この3ステータスでは
    // `resolveAptitudePenalty`が常に0を返す。式へ含めないことでその前提を明示する。
    // 加算の結果は負になり得る（会心率デバフの合計が基本値を超える場合）。実効値への
    // 切り上げはR-CRT-01が行い、ここでは負値のまま返す。
    return input.baseValue + input.formationBonus + combinedEffects + input.fixedCorrection;
  }
  if (input.ratioEffectBaseValue === undefined) {
    return (
      input.baseValue * (1 + input.formationBonus - input.aptitudePenalty) * (1 + combinedEffects) +
      input.fixedCorrection
    );
  }
  // R-TEX-04: `ratioEffectBaseValue`が渡されたときは、戦闘中割合補正の増減量を
  // `baseValue`（ブレイク強化で書き換わり得る）ではなくこちらへ乗算する。
  return (
    input.baseValue * (1 + input.formationBonus - input.aptitudePenalty) +
    input.ratioEffectBaseValue * combinedEffects +
    input.fixedCorrection
  );
}
