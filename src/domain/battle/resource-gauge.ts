import type { Brand } from "../shared/brand.js";
import { DomainValidationError } from "../shared/errors.js";
import { assertFinite, assertInteger } from "../shared/validate.js";

/**
 * R-NUM-02: HP/AP/PP/EX gauge results are truncated toward zero immediately
 * before application, never rounded to nearest.
 */
export function truncateFraction(value: number): number {
  return Math.trunc(value);
}

function createBoundedGauge<BrandName extends string>(
  brandName: BrandName,
  value: number,
  max: number,
  path: string,
): Brand<number, BrandName> {
  assertFinite(value, path);
  assertInteger(max, `${path}.max`, { min: 0 });
  const truncated = truncateFraction(value);
  if (truncated < 0 || truncated > max) {
    throw new DomainValidationError(
      path,
      `${brandName} must be between 0 and ${max} after truncation, got ${truncated}`,
    );
  }
  return truncated as Brand<number, BrandName>;
}

export type HitPoint = Brand<number, "HitPoint">;
/** 0以上、最大HP以下 (`05_ドメインモデル.md` の値オブジェクト表)。0なら戦闘不能。 */
export function createHitPoint(value: number, max: number, path = "hitPoint"): HitPoint {
  return createBoundedGauge("HitPoint", value, max, path);
}

export type ActionPoint = Brand<number, "ActionPoint">;
export function createActionPoint(value: number, max: number, path = "actionPoint"): ActionPoint {
  return createBoundedGauge("ActionPoint", value, max, path);
}

export type PassivePoint = Brand<number, "PassivePoint">;
export function createPassivePoint(
  value: number,
  max: number,
  path = "passivePoint",
): PassivePoint {
  return createBoundedGauge("PassivePoint", value, max, path);
}

export type ExtraGauge = Brand<number, "ExtraGauge">;
/** 超過分を保持しない: max超過は戦闘開始前の境界で拒否する。 */
export function createExtraGauge(value: number, max: number, path = "extraGauge"): ExtraGauge {
  return createBoundedGauge("ExtraGauge", value, max, path);
}
