import { SequenceRandomSource } from "../random/sequence-random-source.js";

/**
 * 命中・会心の抽選を全て「外れ側」（miss判定は命中、crit判定は非会心）へ倒す
 * 決定的乱数列。0.99はどの命中率・会心率の閾値との比較でも安全側に落ちる値。
 * `draws` は対象スキルの抽選消費数に合わせて余裕を持たせる。
 */
export function noMissNoCrit(draws = 64): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(draws).fill(0.99));
}
