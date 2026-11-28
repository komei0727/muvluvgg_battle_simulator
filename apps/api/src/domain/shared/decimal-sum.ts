/**
 * R-NUM-02: 10進で宣言した値どうしの和を、10進の厳密な和に最も近いbinary64へそろえる。
 * binary64の和は10進の和からずれる（`0.848 + 0.075`は`0.92299…`）ため、和を直接宣言した
 * 値と比べると、切り捨ての境界で結果が1つ下がる。
 *
 * 補正するのは、両方の値の最短往復表現が小数第`MAX_DECIMAL_DIGITS`位までに収まるときだけ。
 * その場合、元の値はその桁の10進の有限小数そのもので、和もその桁で表せる。それ以外
 * （生存割合1/3のような評価値・指数表記になる微小値）は10進の有限小数ではないため、
 * 丸めると有効桁を落とす。binary64の和をそのまま返す。
 */
const MAX_DECIMAL_DIGITS = 10;

function fractionDigits(value: number): number | undefined {
  const text = String(value);
  if (text.includes("e")) {
    return undefined;
  }
  const point = text.indexOf(".");
  const digits = point < 0 ? 0 : text.length - point - 1;
  return digits <= MAX_DECIMAL_DIGITS ? digits : undefined;
}

export function addDecimalValues(left: number, right: number): number {
  if (left === 0) {
    return right;
  }
  if (right === 0) {
    return left;
  }
  const leftDigits = fractionDigits(left);
  const rightDigits = fractionDigits(right);
  if (leftDigits === undefined || rightDigits === undefined) {
    return left + right;
  }
  return Number((left + right).toFixed(Math.max(leftDigits, rightDigits)));
}
