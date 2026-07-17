import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export type EventSelector = TriggerDefinition["sourceSelector"];

/**
 * 本番の`event-recorder.ts`は`sourceUnitId`を設定する一方、`sourceSide`は
 * どの呼び出し元も設定していない（Memory由来などIDを持たない発生源の余地として
 * envelopeにフィールドだけが残っている）。そのため`ALLY`/`ENEMY`の陣営判定は
 * `event.sourceSide`だけに頼らず、まず`sourceUnitId`を`unitsById`で引いた実際の
 * `side`を優先し、それが無い場合だけ`event.sourceSide`にフォールバックする。
 */
function resolveSourceSide(
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): Side | undefined {
  if (event.sourceUnitId !== undefined) {
    return unitsById.get(event.sourceUnitId)?.side ?? event.sourceSide;
  }
  return event.sourceSide;
}

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
 * `ALLY`/`ENEMY`はPS所有者自身を含む・含まないの区別を持たず、`resolveSourceSide`
 * が導出した発生源の陣営と所有者の`side`を比較する（自分自身か否かは`SELF`が担う）。
 */
export function evaluateSourceSelector(
  selector: EventSelector,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  rejectEffectOwner(selector, "trigger.sourceSelector");
  switch (selector) {
    case "ANY":
      return true;
    case "SELF":
      return event.sourceUnitId === owner.battleUnitId;
    case "ALLY":
      return resolveSourceSide(event, unitsById) === owner.side;
    case "ENEMY": {
      const side = resolveSourceSide(event, unitsById);
      return side !== undefined && side !== owner.side;
    }
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
