import type {
  BattleSimulationCatalogResponse,
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
    isStringArray(value["positionAptitudes"]) &&
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
