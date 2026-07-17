// Mirrors docs/ui-design/07_UI実装・拡張計画.md §9 (M5 行動ライフサイクル拡張):
// cooldown/chargeをbattleUnitId単位で追跡する。apps/api/src/application/
// simulate-battle-response-mapper.ts の finalState.units[].cooldowns/charge
// はM5時点でも常に空/未設定のスタブのため(cooldownsは`[]`固定、chargeは
// キーごと省略)、finalStateから読むのではなく、events[]のCOOLDOWN_*/
// CHARGE_*をsequence順に走査して再構築する。AP/EXはfinalState.resourcesが
// 既に正しく埋まっているため、そこから直接読む。

import type { RosterEntry } from "../summary/summary-projector.js";
import type {
  BattleLogEventResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";

export interface ResourceValue {
  readonly current: number;
  readonly maximum: number;
}

export interface UnitCooldownState {
  readonly skillDefinitionId: string;
  readonly unit: string;
  readonly remaining: number;
}

export interface UnitChargeState {
  readonly skillDefinitionId: string;
}

export interface UnitActionState {
  readonly battleUnitId: string;
  readonly ap?: ResourceValue;
  readonly extraGauge?: ResourceValue;
  readonly cooldowns: readonly UnitCooldownState[];
  readonly charge?: UnitChargeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readResourceValue(resources: unknown, key: string): ResourceValue | undefined {
  if (!isRecord(resources)) {
    return undefined;
  }
  const value = resources[key];
  if (
    !isRecord(value) ||
    typeof value["current"] !== "number" ||
    typeof value["maximum"] !== "number"
  ) {
    return undefined;
  }
  return { current: value["current"], maximum: value["maximum"] };
}

interface MutableUnitAccumulator {
  readonly cooldowns: Map<string, { unit: string; remaining: number }>;
  charge: UnitChargeState | undefined;
}

function accumulatorFor(
  byUnit: Map<string, MutableUnitAccumulator>,
  battleUnitId: string,
): MutableUnitAccumulator {
  let accumulator = byUnit.get(battleUnitId);
  if (accumulator === undefined) {
    accumulator = { cooldowns: new Map(), charge: undefined };
    byUnit.set(battleUnitId, accumulator);
  }
  return accumulator;
}

function applyCooldownStarted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["unit"] !== "string" ||
    typeof details["initialRemaining"] !== "number"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.cooldowns.set(details["skillDefinitionId"], {
    unit: details["unit"],
    remaining: details["initialRemaining"],
  });
}

function applyCooldownReduced(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["after"] !== "number"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  const current = accumulator.cooldowns.get(details["skillDefinitionId"]);
  accumulator.cooldowns.set(details["skillDefinitionId"], {
    unit: current?.unit ?? "TURN",
    remaining: details["after"],
  });
}

function applyCooldownCompleted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.cooldowns.delete(details["skillDefinitionId"]);
}

function applyChargeStarted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.charge = { skillDefinitionId: details["skillDefinitionId"] };
}

function applyChargeReleased(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (!isRecord(details) || typeof details["actorUnitId"] !== "string") {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.charge = undefined;
}

type ActionStateEventAdapter = (
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
) => void;

const actionStateAdapters: Readonly<Record<string, ActionStateEventAdapter>> = {
  COOLDOWN_STARTED: applyCooldownStarted,
  COOLDOWN_REDUCED: applyCooldownReduced,
  COOLDOWN_COMPLETED: applyCooldownCompleted,
  CHARGE_STARTED: applyChargeStarted,
  CHARGE_RELEASED: applyChargeReleased,
};

// docs/ui-design/07_UI実装・拡張計画.md §9完了条件「cooldown/charge状態を
// battleUnitId単位で追跡できる」。roster順で1エントリずつ返し、events由来の
// 情報が無いunitはcooldowns: []・charge: undefinedになる(M4 fixture後方互換)。
export function selectUnitActionStates(
  response: BattleSimulationResponse,
  roster: readonly RosterEntry[],
): readonly UnitActionState[] {
  const finalUnitsById = new Map(
    response.finalState.units.map((unit) => [unit.battleUnitId, unit] as const),
  );

  const byUnit = new Map<string, MutableUnitAccumulator>();
  const sortedEvents = [...response.events].sort(
    (a, b) => (numberOf(a["sequence"]) ?? 0) - (numberOf(b["sequence"]) ?? 0),
  );
  for (const event of sortedEvents) {
    const adapter = actionStateAdapters[event.type];
    adapter?.(event, byUnit);
  }

  return roster.map((entry) => {
    const finalUnit = finalUnitsById.get(entry.battleUnitId);
    const resources = finalUnit?.["resources"];
    const accumulator = byUnit.get(entry.battleUnitId);
    const ap = readResourceValue(resources, "ap");
    const extraGauge = readResourceValue(resources, "extraGauge");
    const cooldowns =
      accumulator !== undefined
        ? [...accumulator.cooldowns.entries()].map(([skillDefinitionId, state]) => ({
            skillDefinitionId,
            unit: state.unit,
            remaining: state.remaining,
          }))
        : [];
    const charge = accumulator?.charge;
    return {
      battleUnitId: entry.battleUnitId,
      ...(ap !== undefined ? { ap } : {}),
      ...(extraGauge !== undefined ? { extraGauge } : {}),
      cooldowns,
      ...(charge !== undefined ? { charge } : {}),
    };
  });
}
