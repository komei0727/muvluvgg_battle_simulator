import { truncateFraction } from "./resource-gauge.js";
import type { CombatStats } from "./starting-combat-stats.js";
import { DomainValidationError } from "../../shared/errors.js";

/**
 * R-TEX-04 #2: 攻撃力・防御力の増分が0になるブレイク回数。21回目以降は増分を持たず、
 * 累計倍率6.53（653%）で頭打ちになる。HP・行動速度・会心率は上限を持たない。
 */
export const EXERCISE_SCALING_ATTACK_DEFENSE_CAP_BREAK_COUNT = 20;

/** R-TEX-04 #2: 行動速度の1回あたり増分（パーセントポイント）。 */
const ACTION_SPEED_INCREMENT_POINTS = 5;

/** R-TEX-04 #2: 会心率の1回あたり増分（パーセントポイント、絶対値加算）。 */
const CRITICAL_RATE_INCREMENT_POINTS = 1;

/**
 * R-TEX-04が算出する、ブレイク回数に対応する強化量。倍率・加算値のいずれも
 * R-NUM-01に従い丸めずに保持する（整数化は強化後ステータスを求める時点で行う）。
 *
 * 強化後ステータスを求める用途では倍率を経由せず`applyExerciseScaling`を使うこと。
 * 二進浮動小数で表せない倍率（1.4など）を掛けると、数学上は整数になる積がわずかに
 * 下回り、切り捨てで1小さくなる。
 */
export interface ExerciseScalingFactors {
  /** 原基準値の最大HPに掛ける累計倍率。上限なし。 */
  readonly hpMultiplier: number;
  /** 原基準値の攻撃力・防御力に掛ける累計倍率。21回目以降は頭打ち。 */
  readonly attackDefenseMultiplier: number;
  /** 原基準値の行動速度に掛ける累計倍率。上限なし。 */
  readonly actionSpeedMultiplier: number;
  /** 原基準値の会心率へ加算する絶対値（R-NUM-01の内部表現。1pp = 0.01）。 */
  readonly criticalRateAddition: number;
}

/**
 * R-TEX-04 #1: nブレイク目の強化増分（パーセントポイント）。
 * `inc(n) = 20（n≤3）、17+n（n≥4）`。
 */
function increment(breakNumber: number): number {
  return breakNumber <= 3 ? 20 : 17 + breakNumber;
}

/**
 * `Σ(k=1..n) inc(k)` の閉形式（パーセントポイント）。n≥4の区間は公差1の等差数列
 * （inc(4)=21 … inc(n)=17+n）であり、その和は `17(n-3) + (4+n)(n-3)/2` になる。
 *
 * パーセントポイントのまま整数で累積し、倍率へ変換する時点で一度だけ100で割る —
 * 1回ごとに割ってから足すと二進浮動小数の誤差が回数分だけ蓄積するためである。
 */
function cumulativeIncrementPoints(breakCount: number): number {
  if (breakCount <= 3) {
    return increment(1) * breakCount;
  }
  const beyond = breakCount - 3;
  return increment(1) * 3 + 17 * beyond + ((4 + breakCount) * beyond) / 2;
}

function assertBreakCount(breakCount: number): void {
  if (!Number.isInteger(breakCount) || breakCount < 0) {
    throw new DomainValidationError(
      "exerciseScaling.breakCount",
      `must be a non-negative integer (received ${breakCount})`,
    );
  }
}

/**
 * R-TEX-04: ブレイク回数から各ステータスの強化倍率・加算値を算出する純関数。
 *
 * 累計は増分の**加算累積**であり、倍率の乗算（複利）ではない（R-TEX-04 #4）。
 * したがって呼び出し側は常に原基準値へ適用する — 直前の強化後ステータスへ
 * 重ねて適用してはならない。
 */
export function exerciseScalingFactors(breakCount: number): ExerciseScalingFactors {
  const points = scalingPoints(breakCount);
  return {
    hpMultiplier: points.hp / 100,
    attackDefenseMultiplier: points.attackDefense / 100,
    actionSpeedMultiplier: points.actionSpeed / 100,
    criticalRateAddition: points.criticalRate / 100,
  };
}

/**
 * 各ステータスの強化量をパーセントポイントの整数で表したもの。倍率側は原基準値そのもの
 * （100pp）を含む累計であり、会心率側は加算するpp数だけを持つ。
 */
interface ExerciseScalingPoints {
  readonly hp: number;
  readonly attackDefense: number;
  readonly actionSpeed: number;
  readonly criticalRate: number;
}

function scalingPoints(breakCount: number): ExerciseScalingPoints {
  assertBreakCount(breakCount);
  return {
    hp: 100 + cumulativeIncrementPoints(breakCount),
    attackDefense:
      100 +
      cumulativeIncrementPoints(
        Math.min(breakCount, EXERCISE_SCALING_ATTACK_DEFENSE_CAP_BREAK_COUNT),
      ),
    actionSpeed: 100 + ACTION_SPEED_INCREMENT_POINTS * breakCount,
    criticalRate: CRITICAL_RATE_INCREMENT_POINTS * breakCount,
  };
}

/**
 * 整数へ吸着させる許容幅（ULP単位）。実測の誤差は1 ULP（原基準値129.2・7ブレイクの
 * `129.2 × 250 / 100 = 322.99999999999994`）であり、その手前の演算が積む分を見込んで
 * 余裕を取っている。
 *
 * 固定小数桁で丸めてはならない — 強化後基本ステータス（R-ENH-04のギア効果表は
 * 小数第2位のパーセントポイントを持つ）と編成・適性補正を経た値は、数学上も
 * 小数第6位より細かい端数を持ちうる（`57283 × 110.18% × 105% × 385% =
 * 255139.9999995`）。その端数はR-NUM-02が切り捨てるべき実際の値であって誤差ではない。
 */
const INTEGER_SNAP_TOLERANCE_ULPS = 16;

/**
 * 二進浮動小数の丸め誤差で整数からわずかにずれた値を、その整数へ戻す。
 * 誤差と呼べる範囲（ULPの定数倍）だけを対象にし、意味のある端数は変えない。
 * `Math.abs(value) * Number.EPSILON` は正規化数の1 ULP に相当する。
 */
function snapAwayFloatingPointDrift(value: number): number {
  const nearest = Math.round(value);
  const tolerance = INTEGER_SNAP_TOLERANCE_ULPS * Math.abs(value) * Number.EPSILON;
  return Math.abs(value - nearest) <= tolerance ? nearest : value;
}

/**
 * 原基準値へパーセントポイントの強化量を適用する。
 *
 * 二進浮動小数では、数学上ちょうど整数になる積がその整数のわずかに下へずれる
 * （原基準値45・2ブレイクの `45 × 140 / 100`、原基準値129.2・7ブレイクの
 * `129.2 × 250 / 100`）。そのまま切り捨てると強化後ステータスが1小さくなるため、
 * 切り捨て前に誤差分だけを整数へ吸着させる。
 *
 * 倍率（`points / 100`）を先に作らないのも同じ理由である — 1.4のように二進で
 * 表せない倍率を経由すると、原基準値が整数のケースでも誤差が入る。
 */
function scaleByPoints(baseValue: number, points: number): number {
  return truncateFraction(snapAwayFloatingPointDrift((baseValue * points) / 100));
}

/**
 * R-TEX-04: 敵ユニットの原基準値（戦闘開始時に記録した基礎戦闘ステータス）へ
 * ブレイク回数分の強化を適用した基礎戦闘ステータスを求める純関数。
 *
 * R-TEX-04 #5に従い、量として扱うステータス（最大HP・攻撃力・防御力・行動速度）は
 * 小数部分を切り捨てる。会心率は切り捨てない — R-NUM-02が整数化の対象として挙げるのは
 * ダメージ量・リソース量であり、割合そのものは同規則が「途中で丸めない」と定める値
 * （R-NUM-01）だからである。整数化すると1未満の会心率が常に0へ潰れ、絶対値+1pp/回の
 * 強化自体が観測できなくなる。
 *
 * 会心ダメージボーナスと属性相性ボーナスは強化対象外のため原基準値のまま写す
 * （R-TEX-04 #3）。
 */
export function applyExerciseScaling(original: CombatStats, breakCount: number): CombatStats {
  const points = scalingPoints(breakCount);
  return {
    maximumHp: scaleByPoints(original.maximumHp, points.hp),
    attack: scaleByPoints(original.attack, points.attackDefense),
    defense: scaleByPoints(original.defense, points.attackDefense),
    criticalRate: original.criticalRate + points.criticalRate / 100,
    actionSpeed: scaleByPoints(original.actionSpeed, points.actionSpeed),
    criticalDamageBonus: original.criticalDamageBonus,
    affinityBonus: original.affinityBonus,
  };
}
