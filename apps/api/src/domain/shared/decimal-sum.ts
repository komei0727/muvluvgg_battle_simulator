/**
 * R-NUM-02 / R-DMG-08 #10: スキル威力の加算項を10進で合計する。
 *
 * 各値は`String(value)`の最短往復10進表記（指数表記を含む）を入力とし、桁をそろえた
 * 整数（`BigInt`）として全件を合計する。合計は0以上に制限してから一度だけ`number`へ変換する。
 * binary64で逐次加算すると、和が10進の和からずれ（`0.848 + 0.075`は`0.92299…`）、
 * 加算の順序でも結果が変わるためである。
 */
interface ExactDecimal {
  /** 値は`coefficient / 10^scale`。 */
  readonly coefficient: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/;

function parseShortestDecimal(value: number): ExactDecimal {
  const match = DECIMAL_PATTERN.exec(String(value));
  if (match === null) {
    throw new RangeError(`not a finite number: ${String(value)}`);
  }
  const [, sign = "", integerPart = "0", fractionPart = "", exponentPart = "0"] = match;
  const digits = BigInt(`${sign}${integerPart}${fractionPart}`);
  const scale = fractionPart.length - Number(exponentPart);
  return scale >= 0
    ? { coefficient: digits, scale }
    : { coefficient: digits * 10n ** BigInt(-scale), scale: 0 };
}

function decimalText({ coefficient, scale }: ExactDecimal): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - scale);
  const fractionPart = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${integerPart}${fractionPart.length > 0 ? `.${fractionPart}` : ""}`;
}

function exactSum(values: readonly number[]): ExactDecimal {
  const decimals = values.map(parseShortestDecimal);
  const scale = Math.max(0, ...decimals.map((decimal) => decimal.scale));
  const coefficient = decimals.reduce(
    (sum, decimal) => sum + decimal.coefficient * 10n ** BigInt(scale - decimal.scale),
    0n,
  );
  return { coefficient, scale };
}

/** 全件を10進で合計し、一度だけ`number`へ変換する（内訳表示用の加算値の合計に使う）。 */
export function sumDecimalValues(values: readonly number[]): number {
  return Number(decimalText(exactSum(values)));
}

/** 全件を10進で合計し、0以上に制限してから一度だけ`number`へ変換する。 */
export function sumDecimalValuesAtLeastZero(values: readonly number[]): number {
  const sum = exactSum(values);
  return sum.coefficient <= 0n ? 0 : Number(decimalText(sum));
}
