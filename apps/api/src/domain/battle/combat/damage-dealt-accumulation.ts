import { cumulativeDamageDealtOf, type BattleUnit } from "../model/battle-unit.js";
import type { UnitStateDelta, ValueChange } from "../events/state-delta.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface DamageDealtAccumulation {
  readonly unit: BattleUnit;
  /** 加算量が0なら状態が変わらないため差分を持たない。 */
  readonly change?: ValueChange<number>;
}

/**
 * Issue #700: 付与者の累計与ダメージへ1回分を加算する。`amount`は呼び出し側が
 * `hitPointDamage + discardedDamage`（シールド・サブユニット吸収分を除き、オーバーキル分を含む）
 * として渡す — 戦闘結果の`unitSummaries[].damageDealt`と同じ定義に揃えるためである。
 */
export function accumulateDamageDealt(unit: BattleUnit, amount: number): DamageDealtAccumulation {
  if (amount <= 0) {
    return { unit };
  }
  const before = cumulativeDamageDealtOf(unit);
  const after = before + amount;
  return { unit: { ...unit, cumulativeDamageDealt: after }, change: { before, after } };
}

/**
 * 対象のHP差分と付与者の累計与ダメージ差分を1つの`units`差分へまとめる。自傷（付与者＝対象）
 * では同じユニットの差分へ両方を載せる — 別々に書くと後者が前者を上書きしてしまう。
 */
export function withDamageDealtDelta(
  units: Readonly<Record<BattleUnitId, UnitStateDelta>>,
  sourceUnitId: BattleUnitId | undefined,
  change: ValueChange<number> | undefined,
): Readonly<Record<BattleUnitId, UnitStateDelta>> {
  if (sourceUnitId === undefined || change === undefined) {
    return units;
  }
  return { ...units, [sourceUnitId]: { ...units[sourceUnitId], cumulativeDamageDealt: change } };
}
