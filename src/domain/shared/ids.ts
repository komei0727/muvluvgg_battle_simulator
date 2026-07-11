import type { Brand } from "./brand.js";
import { DomainValidationError } from "./errors.js";

export type BattleId = Brand<string, "BattleId">;
export type BattleUnitId = Brand<string, "BattleUnitId">;

function requireNonEmpty(brandName: string, path: string, value: string): void {
  if (value.length === 0) {
    throw new DomainValidationError(path, `${brandName} must not be empty`);
  }
}

/** `BattleIdGenerator` is the only intended caller in production code. */
export function createBattleId(value: string, path = "battleId"): BattleId {
  requireNonEmpty("BattleId", path, value);
  return value as BattleId;
}

/** One per participation slot; distinct even for repeated `UnitDefinitionId`s. */
export function createBattleUnitId(value: string, path = "battleUnitId"): BattleUnitId {
  requireNonEmpty("BattleUnitId", path, value);
  return value as BattleUnitId;
}
