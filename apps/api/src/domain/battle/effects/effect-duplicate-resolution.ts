import type { AppliedEffect, EffectKindKey } from "../model/applied-effect.js";

/**
 * R-EFF-05 / R-STA-03: 重複あり効果はすべてactiveのまま。重複なし効果は
 * `EffectKindKey`単位でグループ化し、強度（効果量の絶対値。バフは正の効果量、
 * デバフは弱化量の大きさで比較）が最大の1件だけをactiveにする。同じ強度の
 * 候補が複数ある場合は配列順（=付与順）が最初のものを代表として維持する
 * （「効果インスタンスは変更せず最初に付与されたものを代表として扱う」）。
 *
 * ステートレスな再計算関数として実装する: 呼び出し側は付与・失効のたびに
 * 現在の全AppliedEffectを渡してactiveフラグを引き直す。配列は常に付与順で
 * 末尾追加・該当インスタンス削除だけを行う前提（呼び出し側の不変条件）。
 */
export function recomputeActiveEffects(
  effects: readonly AppliedEffect[],
): readonly AppliedEffect[] {
  const strongestIndexByKindKey = new Map<EffectKindKey, number>();
  effects.forEach((effect, index) => {
    if (effect.duplicate) {
      return;
    }
    const currentBestIndex = strongestIndexByKindKey.get(effect.kindKey);
    if (currentBestIndex === undefined) {
      strongestIndexByKindKey.set(effect.kindKey, index);
      return;
    }
    const currentBest = effects[currentBestIndex]!;
    if (Math.abs(effect.magnitude) > Math.abs(currentBest.magnitude)) {
      strongestIndexByKindKey.set(effect.kindKey, index);
    }
  });

  return effects.map((effect, index) => {
    if (effect.duplicate) {
      return effect.active ? effect : { ...effect, active: true };
    }
    const active = strongestIndexByKindKey.get(effect.kindKey) === index;
    return effect.active === active ? effect : { ...effect, active };
  });
}
