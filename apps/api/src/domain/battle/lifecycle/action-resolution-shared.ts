import type { BattleUnit } from "../model/battle-unit.js";
import { createActionPoint, createExtraGauge } from "../model/resource-gauge.js";
import type { DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

/** WAIT・AS/EX使用・チャージ開始・チャージ発動のすべてで共有される1行動の解決結果。呼び出し側（`resolveActionPhase`）が`ActionReservationRemoved`を同じ解決スコープへ連鎖させるために使う。 */
export interface ActionResolutionResult {
  readonly units: readonly BattleUnit[];
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly completedEventId: DomainEventId;
}

export type ResolvableEffectiveActionType = "AS" | "EX" | "WAIT" | "CHARGE_RELEASE";

export function requireUnit(units: readonly BattleUnit[], id: BattleUnitId): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError("battleUnitId", `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

export function consumeAp(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentAp: createActionPoint(unit.currentAp - amount, unit.maximumAp) }
      : unit,
  );
}

/** R-ACT-03（EX行）: APは消費せず、EXゲージを全量消費する。 */
export function consumeExGaugeFully(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentExtraGauge: createExtraGauge(0, unit.maximumExtraGauge) }
      : unit,
  );
}
