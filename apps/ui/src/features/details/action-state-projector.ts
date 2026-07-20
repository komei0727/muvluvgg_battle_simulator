// Mirrors docs/ui-design/07_UI実装・拡張計画.md §9 (M5 行動ライフサイクル拡張):
// cooldown/chargeをbattleUnitId単位で追跡する。apps/api/src/application/
// simulate-battle-response-mapper.ts の finalState.units[].cooldowns/charge
// はM5実装後、Domainの実値を返す(cooldownsは残数>0のスキルだけの配列)。
// `finalState`はlogLevelに関わらず常に完全（`captureBattleState`はlogLevelを
// 見ない）なので、これを正本として読む(PR #131レビューで露呈したSUMMARYログの
// 「不明」表示問題は、finalStateを使う限りそもそも発生しない)。
//
// `cooldowns`はM5以降の契約で必須配列（空でも`[]`）のため、その有無で
// finalStateがM5以降の形かどうかを判別できる。`cooldowns`キー自体が無い
// unit(M5より前に録取したUI fixture)だけ、events[]のCOOLDOWN_*/CHARGE_*を
// sequence順に走査するfallbackへ回す。fallback経路では、
// logLevel=SUMMARYだとapps/api/src/application/observation/battle-log-projection.tsの
// SUMMARY_EVENT_TYPESにCooldown*/Charge*が含まれずevents[]へ載らないため、
// `cooldownChargeKnown`で呼び出し側に不明であることを伝える。

import type { RosterEntry } from "../summary/summary-projector.js";
import type { LogLevel } from "../formation/types.js";
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
  readonly pp?: ResourceValue;
  readonly extraGauge?: ResourceValue;
  readonly cooldowns: readonly UnitCooldownState[];
  readonly charge?: UnitChargeState;
  /** falseの場合、cooldowns/chargeが空でも「クールタイム/チャージなし」を意味しない(SUMMARYログ)。 */
  readonly cooldownChargeKnown: boolean;
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

/** `finalUnit["cooldowns"]`がM5以降の契約通りの配列であれば、要素を`UnitCooldownState`へ変換して返す。配列でなければ(M5より前のfixture)`undefined`。 */
function readCooldownsFromFinalState(finalUnit: unknown): readonly UnitCooldownState[] | undefined {
  if (!isRecord(finalUnit) || !Array.isArray(finalUnit["cooldowns"])) {
    return undefined;
  }
  const cooldowns: UnitCooldownState[] = [];
  for (const entry of finalUnit["cooldowns"]) {
    if (
      isRecord(entry) &&
      typeof entry["skillDefinitionId"] === "string" &&
      typeof entry["unit"] === "string" &&
      typeof entry["remaining"] === "number"
    ) {
      cooldowns.push({
        skillDefinitionId: entry["skillDefinitionId"],
        unit: entry["unit"],
        remaining: entry["remaining"],
      });
    }
  }
  return cooldowns;
}

/** `finalUnit["charge"]`（`10_API設計.md`「ChargeStateResponse」）を`UnitChargeState`へ変換する。チャージ中でなければ`undefined`。 */
function readChargeFromFinalState(finalUnit: unknown): UnitChargeState | undefined {
  if (!isRecord(finalUnit)) {
    return undefined;
  }
  const charge = finalUnit["charge"];
  if (!isRecord(charge) || typeof charge["skillDefinitionId"] !== "string") {
    return undefined;
  }
  return { skillDefinitionId: charge["skillDefinitionId"] };
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
// battleUnitId単位で追跡できる」。roster順で1エントリずつ返す。`finalState`が
// M5以降の形（`cooldowns`が配列）を持つunitはそれを正本として使い、
// 持たないunit(M5より前のUI fixture)だけevents[]からの再構築へfallbackする。
export function selectUnitActionStates(
  response: BattleSimulationResponse,
  roster: readonly RosterEntry[],
  logLevel: LogLevel,
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
    const ap = readResourceValue(resources, "ap");
    const pp = readResourceValue(resources, "pp");
    const extraGauge = readResourceValue(resources, "extraGauge");

    const cooldownsFromFinalState = readCooldownsFromFinalState(finalUnit);
    // `finalState`はlogLevelに関わらず常に完全なので、そこから読めた時点で
    // 不明な点はない。events[]へのfallback時だけSUMMARYログの間引きが影響する。
    const cooldownChargeKnown = cooldownsFromFinalState !== undefined || logLevel !== "SUMMARY";
    const accumulator = byUnit.get(entry.battleUnitId);
    const cooldowns =
      cooldownsFromFinalState ??
      (accumulator !== undefined
        ? [...accumulator.cooldowns.entries()].map(([skillDefinitionId, state]) => ({
            skillDefinitionId,
            unit: state.unit,
            remaining: state.remaining,
          }))
        : []);
    const charge =
      cooldownsFromFinalState !== undefined
        ? readChargeFromFinalState(finalUnit)
        : accumulator?.charge;
    return {
      battleUnitId: entry.battleUnitId,
      ...(ap !== undefined ? { ap } : {}),
      ...(pp !== undefined ? { pp } : {}),
      ...(extraGauge !== undefined ? { extraGauge } : {}),
      cooldowns,
      ...(charge !== undefined ? { charge } : {}),
      cooldownChargeKnown,
    };
  });
}
