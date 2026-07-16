// Mirrors docs/ui-design/03_API・データ連携設計.md §10 (表示用Roster), §11
// (サマリ集計), §11.4 (Adapter registry). DAMAGE/DEFENSE come from
// DAMAGE_APPLIED.details.hitPointDamage, never calculatedDamage
// (01_UI要求・画面設計.md §7.2). HEAL stays 0 until the M7 heal event
// contract exists (03 §11.3).

import type {
  BattleLogEventResponse,
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  UiApiError,
} from "../simulation/api-contract.js";

export interface RosterEntry {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly displayName: string;
}

export interface UnitBattleSummary {
  readonly battleUnitId: string;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly combatStatus: string;
  readonly finalHp: number;
  readonly maximumHp: number;
}

export interface SummaryRow {
  readonly roster: RosterEntry;
  readonly summary: UnitBattleSummary;
}

export interface SummaryProjection {
  readonly allyRows: readonly SummaryRow[];
  readonly enemyRows: readonly SummaryRow[];
  readonly hasProjectionWarning: boolean;
}

// selectBattleSummary can fail outright when finalState doesn't correspond to
// the initialState roster (see the contract-mismatch check below), so it
// returns a Result instead of always producing a projection.
export type SummaryProjectionResult =
  | { readonly ok: true; readonly projection: SummaryProjection }
  | { readonly ok: false; readonly error: UiApiError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// API契約上hitPointDamageはintegerである(apps/api/src/presentation/http/
// schemas.ts damageAppliedDetailsSchema)。小数を受理すると表示側の
// toLocaleString()が丸めて誤った値を見せるため、ここでも整数だけ受理する。
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// docs/ui-design/03_API・データ連携設計.md §10「表示用Roster」の生成手順:
// initialState.units を入力順で走査し、Catalog未解決なら
// displayName = unitDefinitionId とする。
export function selectRoster(
  response: BattleSimulationResponse,
  catalog: BattleSimulationCatalogResponse,
): readonly RosterEntry[] {
  const catalogByDefinitionId = new Map(
    catalog.units.map((unit) => [unit.unitDefinitionId, unit] as const),
  );

  return response.initialState.units.map((unit) => {
    const definition = catalogByDefinitionId.get(unit.unitDefinitionId);
    return {
      battleUnitId: unit.battleUnitId,
      unitDefinitionId: unit.unitDefinitionId,
      side: unit.side,
      displayName: definition?.displayName ?? unit.unitDefinitionId,
    };
  });
}

interface MutableSummaryAccumulator {
  readonly damageDealt: Map<string, number>;
  readonly damageTaken: Map<string, number>;
  readonly validBattleUnitIds: ReadonlySet<string>;
  warned: boolean;
}

function addTo(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

// docs/ui-design/03_API・データ連携設計.md §11.4「Adapter registry」。
// sourceUnitId欠落、targetUnitId不明、details shape不正の場合はそのイベント
// を集計から除外し、警告フラグだけ立てる(UI-UT-SUM-009)。sourceUnitId/
// targetUnitIdがRosterに存在しない場合も同様に除外する。片側だけ加算する
// と対応するDEFENSE/DAMAGEが欠けたまま警告なしに見えてしまうため。
function applyDamageApplied(
  event: BattleLogEventResponse,
  accumulator: MutableSummaryAccumulator,
): void {
  const sourceUnitId = event["sourceUnitId"];
  const details = event["details"];
  if (typeof sourceUnitId !== "string" || !isRecord(details)) {
    accumulator.warned = true;
    return;
  }
  const targetUnitId = details["targetUnitId"];
  const hitPointDamage = details["hitPointDamage"];
  if (typeof targetUnitId !== "string" || !isNonNegativeInteger(hitPointDamage)) {
    accumulator.warned = true;
    return;
  }
  if (
    !accumulator.validBattleUnitIds.has(sourceUnitId) ||
    !accumulator.validBattleUnitIds.has(targetUnitId)
  ) {
    accumulator.warned = true;
    return;
  }
  addTo(accumulator.damageDealt, sourceUnitId, hitPointDamage);
  addTo(accumulator.damageTaken, targetUnitId, hitPointDamage);
}

type SummaryEventAdapter = (
  event: BattleLogEventResponse,
  accumulator: MutableSummaryAccumulator,
) => void;

const summaryAdapters: Readonly<Record<string, SummaryEventAdapter>> = {
  DAMAGE_APPLIED: applyDamageApplied,
  // M7: HEAL_APPLIED等、API契約確定後に追加(03 §11.3)。
};

export function selectBattleSummary(
  response: BattleSimulationResponse,
  catalog: BattleSimulationCatalogResponse,
): SummaryProjectionResult {
  const roster = selectRoster(response, catalog);
  const finalUnitsById = new Map(
    response.finalState.units.map((unit) => [unit.battleUnitId, unit] as const),
  );

  // docs/ui-design/03_API・データ連携設計.md §10 rule 5: finalに存在しない
  // unitは契約不一致とする。UNKNOWN/0へfallbackして正常に見せない。
  const missingFromFinalState = roster.find((entry) => !finalUnitsById.has(entry.battleUnitId));
  if (missingFromFinalState !== undefined) {
    return {
      ok: false,
      error: {
        kind: "RESPONSE_CONTRACT_MISMATCH",
        message: `finalState is missing battleUnitId "${missingFromFinalState.battleUnitId}" present in initialState.`,
      },
    };
  }

  const accumulator: MutableSummaryAccumulator = {
    damageDealt: new Map(),
    damageTaken: new Map(),
    validBattleUnitIds: new Set(roster.map((entry) => entry.battleUnitId)),
    warned: false,
  };
  for (const event of response.events) {
    const adapter = summaryAdapters[event.type];
    adapter?.(event, accumulator);
  }

  const allyRows: SummaryRow[] = [];
  const enemyRows: SummaryRow[] = [];
  for (const entry of roster) {
    // Non-null: the contract-mismatch check above already guarantees every
    // roster battleUnitId exists in finalUnitsById.
    const finalUnit = finalUnitsById.get(entry.battleUnitId)!;
    const summary: UnitBattleSummary = {
      battleUnitId: entry.battleUnitId,
      damageDealt: accumulator.damageDealt.get(entry.battleUnitId) ?? 0,
      damageTaken: accumulator.damageTaken.get(entry.battleUnitId) ?? 0,
      healingDone: 0,
      combatStatus: finalUnit.combatStatus,
      finalHp: finalUnit.hp.current,
      maximumHp: finalUnit.hp.maximum,
    };
    const row: SummaryRow = { roster: entry, summary };
    if (entry.side === "ENEMY") {
      enemyRows.push(row);
    } else {
      allyRows.push(row);
    }
  }

  return {
    ok: true,
    projection: { allyRows, enemyRows, hasProjectionWarning: accumulator.warned },
  };
}
