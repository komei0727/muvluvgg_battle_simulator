import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogMemorySummary,
  CatalogUnitSummary,
  UiApiError,
} from "./api-contract.js";

// docs/ui-design/03_API・データ連携設計.md §8: 一覧レスポンスの検証.
// 契約違反時は編成を有効にせず RESPONSE_CONTRACT_MISMATCH を返す。

export type CatalogValidationResult =
  | { readonly ok: true; readonly response: BattleSimulationCatalogResponse }
  | { readonly ok: false; readonly error: UiApiError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const POSITION_APTITUDES = ["FRONT", "BACK"];

// apps/api/src/presentation/http/schemas.ts の catalogUnitSummaryResponseSchema:
// positionAptitudes は FRONT/BACK のみを許容する enum で、1件以上必須。
function isPositionAptitudes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && POSITION_APTITUDES.includes(item))
  );
}

function hasValidAvailability(value: Record<string, unknown>): boolean {
  const { selectable, unavailableCapabilities } = value;
  if (typeof selectable !== "boolean" || !isStringArray(unavailableCapabilities)) {
    return false;
  }
  return selectable ? unavailableCapabilities.length === 0 : unavailableCapabilities.length > 0;
}

function isValidUnit(value: unknown): value is CatalogUnitSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["unitDefinitionId"]) &&
    isNonEmptyString(value["displayName"]) &&
    isNonEmptyString(value["characterName"]) &&
    isNonEmptyString(value["attribute"]) &&
    isNonEmptyString(value["unitType"]) &&
    isNonEmptyString(value["role"]) &&
    isPositionAptitudes(value["positionAptitudes"]) &&
    hasValidAvailability(value)
  );
}

function isValidMemory(value: unknown): value is CatalogMemorySummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["memoryDefinitionId"]) &&
    isNonEmptyString(value["displayName"]) &&
    hasValidAvailability(value)
  );
}

function hasDuplicateIds(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

function mismatch(message: string): CatalogValidationResult {
  return { ok: false, error: { kind: "RESPONSE_CONTRACT_MISMATCH", message } };
}

export function validateCatalogResponse(body: unknown): CatalogValidationResult {
  if (!isRecord(body)) {
    return mismatch("Catalog response body is not a JSON object.");
  }

  if (body["schemaVersion"] !== 1) {
    return mismatch("Catalog response schemaVersion is not 1.");
  }

  if (!isNonEmptyString(body["catalogRevision"])) {
    return mismatch("Catalog response catalogRevision is missing or empty.");
  }

  const units = body["units"];
  const memories = body["memories"];
  if (!Array.isArray(units)) {
    return mismatch("Catalog response units is not an array.");
  }
  if (!Array.isArray(memories)) {
    return mismatch("Catalog response memories is not an array.");
  }

  if (!units.every(isValidUnit)) {
    return mismatch("Catalog response contains a malformed unit entry.");
  }
  if (!memories.every(isValidMemory)) {
    return mismatch("Catalog response contains a malformed memory entry.");
  }

  const unitIds = units.map((unit) => unit.unitDefinitionId);
  if (hasDuplicateIds(unitIds)) {
    return mismatch("Catalog response contains duplicate unitDefinitionId values.");
  }

  const memoryIds = memories.map((memory) => memory.memoryDefinitionId);
  if (hasDuplicateIds(memoryIds)) {
    return mismatch("Catalog response contains duplicate memoryDefinitionId values.");
  }

  return {
    ok: true,
    response: {
      schemaVersion: 1,
      catalogRevision: body["catalogRevision"],
      units,
      memories,
    },
  };
}

// docs/ui-design/03_API・データ連携設計.md §9: 戦闘成功レスポンスの検証.
// 必須shapeだけを確認し、未知の任意プロパティ・イベントtype・列挙値は許容する
// (OpenAPI全体を厳格に再実装して将来の追加を拒否しない)。

export type SimulationValidationResult =
  | { readonly ok: true; readonly response: BattleSimulationResponse }
  | { readonly ok: false; readonly error: UiApiError };

function simulationMismatch(message: string): SimulationValidationResult {
  return { ok: false, error: { kind: "RESPONSE_CONTRACT_MISMATCH", message } };
}

function isValidResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["outcome"]) &&
    isNonEmptyString(value["completionReason"]) &&
    typeof value["completedTurn"] === "number"
  );
}

function isValidHp(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["current"] === "number" && typeof value["maximum"] === "number";
}

function isValidBattleUnit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["battleUnitId"]) &&
    isNonEmptyString(value["unitDefinitionId"]) &&
    isNonEmptyString(value["side"]) &&
    isNonEmptyString(value["combatStatus"]) &&
    isValidHp(value["hp"])
  );
}

function isValidBattleState(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const units = value["units"];
  return Array.isArray(units) && units.every(isValidBattleUnit);
}

function battleUnitIdOf(unit: unknown): string | undefined {
  if (!isRecord(unit)) {
    return undefined;
  }
  const battleUnitId = unit["battleUnitId"];
  return typeof battleUnitId === "string" ? battleUnitId : undefined;
}

// docs/ui-design/03_API・データ連携設計.md §10 rule 5: finalに存在しない
// unitは契約不一致とする。呼び出し時点でinitialState/finalStateの shape は
// isValidBattleState で検証済みだが、両者の対応関係はここでしか検証できない
// ため、ここで200成功レスポンス自体を拒否する(UIの表示層まで壊れた状態を
// 通過させない)。
function hasMatchingFinalStateUnits(initialState: unknown, finalState: unknown): boolean {
  if (!isRecord(initialState) || !isRecord(finalState)) {
    return false;
  }
  const initialUnits = initialState["units"];
  const finalUnits = finalState["units"];
  if (!Array.isArray(initialUnits) || !Array.isArray(finalUnits)) {
    return false;
  }
  const finalBattleUnitIds = new Set(
    finalUnits.map(battleUnitIdOf).filter((id): id is string => id !== undefined),
  );
  return initialUnits.every((unit) => {
    const battleUnitId = battleUnitIdOf(unit);
    return battleUnitId !== undefined && finalBattleUnitIds.has(battleUnitId);
  });
}

export function validateSimulationResponse(body: unknown): SimulationValidationResult {
  if (!isRecord(body)) {
    return simulationMismatch("Simulation response body is not a JSON object.");
  }

  if (typeof body["schemaVersion"] !== "number") {
    return simulationMismatch("Simulation response schemaVersion is not a number.");
  }
  if (!isNonEmptyString(body["battleId"])) {
    return simulationMismatch("Simulation response battleId is missing or empty.");
  }
  if (!isNonEmptyString(body["catalogRevision"])) {
    return simulationMismatch("Simulation response catalogRevision is missing or empty.");
  }
  if (!isValidResult(body["result"])) {
    return simulationMismatch("Simulation response result is malformed.");
  }
  if (!isValidBattleState(body["initialState"])) {
    return simulationMismatch("Simulation response initialState.units is malformed.");
  }
  if (!isValidBattleState(body["finalState"])) {
    return simulationMismatch("Simulation response finalState.units is malformed.");
  }
  if (!hasMatchingFinalStateUnits(body["initialState"], body["finalState"])) {
    return simulationMismatch(
      "Simulation response finalState is missing a battleUnitId present in initialState.",
    );
  }
  if (!Array.isArray(body["events"])) {
    return simulationMismatch("Simulation response events is not an array.");
  }
  if (!Array.isArray(body["stateTransitions"])) {
    return simulationMismatch("Simulation response stateTransitions is not an array.");
  }

  return {
    ok: true,
    response: body as unknown as BattleSimulationResponse,
  };
}
