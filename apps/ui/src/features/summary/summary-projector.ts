// Mirrors docs/ui-design/03_API・データ連携設計.md §10 (表示用Roster), §11
// (サマリ集計), §11.4 (Adapter registry). DAMAGE/DEFENSE come from
// DAMAGE_APPLIED.details.hitPointDamage, never calculatedDamage
// (01_UI要求・画面設計.md §7.2). HEAL comes from the M7 heal event contract
// (HEAL_APPLIED / HEALING_TRANSFERRED の details.appliedAmount, 03 §11.3).

import type {
  BattleLogEventResponse,
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// API契約上hitPointDamageはintegerである(apps/api/src/presentation/http/
// schemas/battle-log/battle-log-schema.ts damageAppliedDetailsSchema)。
// 小数を受理すると表示側のtoLocaleString()が丸めて誤った値を見せるため、
// ここでも整数だけ受理する。
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
  readonly healingDone: Map<string, number>;
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

// docs/ui-design/01_UI要求・画面設計.md §7.2「HEAL: 実HP回復量」/
// 07_UI実装・拡張計画.md §11「HEALは要求量ではなく実HP回復量を集計する」。
// HealApplied.details.appliedAmount は「最大HPを超えない範囲で実際に増加したHP量」
// (apps/api/src/domain/battle/events/domain-event.ts) であり、要求量である
// healAmount でも破棄分を含む formulaResult でもない。回復者(details.sourceUnitId)
// 側へ積む — DAMAGEをsourceUnitIdへ積むのと同じ規約。
function applyHealApplied(
  event: BattleLogEventResponse,
  accumulator: MutableSummaryAccumulator,
): void {
  const details = event["details"];
  if (!isRecord(details)) {
    accumulator.warned = true;
    return;
  }
  const sourceUnitId = details["sourceUnitId"];
  const targetUnitId = details["targetUnitId"];
  const appliedAmount = details["appliedAmount"];
  if (
    typeof sourceUnitId !== "string" ||
    typeof targetUnitId !== "string" ||
    !isNonNegativeInteger(appliedAmount)
  ) {
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
  addTo(accumulator.healingDone, sourceUnitId, appliedAmount);
}

// R-HEAL-04 (M7-005-HEAL-LINK, Issue #229): 回復リンクは HealApplied の回復量の
// 一部を別ユニットへ移し替える。HealApplied.appliedAmount は転送分を含まない
// ため、転送先で実際に増えたHP量 (HealingTransferred.details.appliedAmount) を
// 加算しないと回復者の実回復量を過小表示する。転送分の「回復者」はイベント側の
// sourceUnitId (元のHealApplied と同じ context.sourceUnitId) を正本とし、
// details.fromUnitId(リンク保持者)を回復者と読み替える推測はしない。
function applyHealingTransferred(
  event: BattleLogEventResponse,
  accumulator: MutableSummaryAccumulator,
): void {
  const sourceUnitId = event["sourceUnitId"];
  const details = event["details"];
  if (typeof sourceUnitId !== "string" || !isRecord(details)) {
    accumulator.warned = true;
    return;
  }
  const toUnitId = details["toUnitId"];
  const appliedAmount = details["appliedAmount"];
  if (typeof toUnitId !== "string" || !isNonNegativeInteger(appliedAmount)) {
    accumulator.warned = true;
    return;
  }
  if (
    !accumulator.validBattleUnitIds.has(sourceUnitId) ||
    !accumulator.validBattleUnitIds.has(toUnitId)
  ) {
    accumulator.warned = true;
    return;
  }
  addTo(accumulator.healingDone, sourceUnitId, appliedAmount);
}

type SummaryEventAdapter = (
  event: BattleLogEventResponse,
  accumulator: MutableSummaryAccumulator,
) => void;

const summaryAdapters: Readonly<Record<string, SummaryEventAdapter>> = {
  DAMAGE_APPLIED: applyDamageApplied,
  HEAL_APPLIED: applyHealApplied,
  HEALING_TRANSFERRED: applyHealingTransferred,
};

// finalState/initialStateのroster対応関係は、成功レスポンス全体を失敗させる
// べき契約違反であるため、simulation/response-validator.ts の
// validateSimulationResponse で検証し、execution状態をfailedへ遷移させる
// (このプロジェクタへは既に対応関係が保証された response しか渡らない)。
export function selectBattleSummary(
  response: BattleSimulationResponse,
  catalog: BattleSimulationCatalogResponse,
): SummaryProjection {
  const roster = selectRoster(response, catalog);
  const finalUnitsById = new Map(
    response.finalState.units.map((unit) => [unit.battleUnitId, unit] as const),
  );

  const accumulator: MutableSummaryAccumulator = {
    damageDealt: new Map(),
    damageTaken: new Map(),
    healingDone: new Map(),
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
    const finalUnit = finalUnitsById.get(entry.battleUnitId);
    const summary: UnitBattleSummary = {
      battleUnitId: entry.battleUnitId,
      damageDealt: accumulator.damageDealt.get(entry.battleUnitId) ?? 0,
      damageTaken: accumulator.damageTaken.get(entry.battleUnitId) ?? 0,
      healingDone: accumulator.healingDone.get(entry.battleUnitId) ?? 0,
      combatStatus: finalUnit?.combatStatus ?? "UNKNOWN",
      finalHp: finalUnit?.hp.current ?? 0,
      maximumHp: finalUnit?.hp.maximum ?? 0,
    };
    const row: SummaryRow = { roster: entry, summary };
    if (entry.side === "ENEMY") {
      enemyRows.push(row);
    } else {
      allyRows.push(row);
    }
  }

  return { allyRows, enemyRows, hasProjectionWarning: accumulator.warned };
}
