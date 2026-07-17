import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export type EventSelector = TriggerDefinition["sourceSelector"];

function rejectEffectOwner(
  selector: EventSelector,
  path: string,
): asserts selector is Exclude<EventSelector, "EFFECT_OWNER"> {
  if (selector === "EFFECT_OWNER") {
    throw new DomainValidationError(
      path,
      'selector "EFFECT_OWNER" is not supported by this basic PassiveTriggerMatcher (requires AppliedEffect ownership, M7 scope)',
    );
  }
}

/**
 * R-PS-01「発生源...をConditionDefinitionで評価する」のうち`sourceSelector`部分。
 * `ALLY`/`ENEMY`はPS所有者自身を含む・含まないの区別を持たず、単純に
 * `event.sourceSide`と所有者の`side`を比較する（自分自身か否かは`SELF`が担う）。
 */
export function evaluateSourceSelector(
  selector: EventSelector,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
): boolean {
  rejectEffectOwner(selector, "trigger.sourceSelector");
  switch (selector) {
    case "ANY":
      return true;
    case "SELF":
      return event.sourceUnitId === owner.battleUnitId;
    case "ALLY":
      return event.sourceSide === owner.side;
    case "ENEMY":
      return event.sourceSide !== undefined && event.sourceSide !== owner.side;
  }
}

/**
 * R-PS-01「...対象...をConditionDefinitionで評価する」のうち`targetSelector`部分。
 * `targetUnitIds`は複数持ちうるため、いずれか1件が条件を満たせば候補にする。
 */
export function evaluateTargetSelector(
  selector: EventSelector,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  rejectEffectOwner(selector, "trigger.targetSelector");
  if (selector === "ANY") {
    return true;
  }
  const targetUnitIds = event.targetUnitIds;
  if (targetUnitIds === undefined || targetUnitIds.length === 0) {
    return false;
  }
  return targetUnitIds.some((id) => {
    if (selector === "SELF") {
      return id === owner.battleUnitId;
    }
    const target = unitsById.get(id);
    if (target === undefined) {
      return false;
    }
    return selector === "ALLY" ? target.side === owner.side : target.side !== owner.side;
  });
}
