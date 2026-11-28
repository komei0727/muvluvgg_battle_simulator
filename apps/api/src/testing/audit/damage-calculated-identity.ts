import { addDecimalValues } from "../../domain/shared/decimal-sum.js";

/**
 * `08_ドメインイベント.md`「payload単体での再現可能性」の恒等式を、`DAMAGE_CALCULATED`
 * （`DamageCalculated`）の計算項目だけから評価する。記録済みの中間値を使わず、
 * 基礎ダメージから最終ダメージまでを導く。
 *
 * 省略された項目は乗算の中立値1（加算値・率は0）として読む。R-SUB-02の追加ヒットは
 * 基礎ダメージの項を持たず、`skillPower`がFormula評価結果そのものになるためである。
 */
export interface ReproducedDamage {
  readonly rawPreTruncationDamage: number;
  readonly preTruncationDamage: number;
  readonly finalDamage: number;
}

export function reproduceDamageCalculated(
  details: Readonly<Record<string, unknown>>,
): ReproducedDamage {
  const num = (key: string, fallback: number): number => {
    const value = details[key];
    return typeof value === "number" ? value : fallback;
  };
  // R-DMG-08 #10・R-NUM-02: 威力と加算値の和は10進の値どうしの和として求める。
  const skillPower = Math.max(0, addDecimalValues(num("skillPower", 1), num("skillPowerBonus", 0)));
  const rawPreTruncationDamage =
    num("baseDamage", 1) *
    skillPower *
    num("skillPowerMultiplier", 1) *
    num("attributeMultiplier", 1) *
    num("criticalMultiplier", 1) *
    num("outgoingDamageMultiplier", 1) *
    num("incomingDamageMultiplier", 1) *
    num("actionDamageMultiplier", 1) *
    num("confusionDamageMultiplier", 1);
  const preTruncationDamage =
    rawPreTruncationDamage * num("freezeMultiplier", 1) * (1 - num("guardRate", 0));
  const truncated = Math.max(1, Math.floor(preTruncationDamage));
  const finalDamage =
    details["damageImmunityNullified"] === true
      ? 0
      : Math.max(1, Math.floor(truncated * num("thresholdReductionMultiplier", 1)));
  return { rawPreTruncationDamage, preTruncationDamage, finalDamage };
}
