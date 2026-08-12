import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogMemorySummary,
  CatalogUnitSummary,
  FormationStatPreviewResponse,
  TacticalExerciseResponse,
  UiApiError,
} from "./api-contract.js";
import { isRecord } from "../../lib/unknown-narrowing.js";

// docs/ui-design/03_API・データ連携設計.md §8: 一覧レスポンスの検証.
// 契約違反時は編成を有効にせず RESPONSE_CONTRACT_MISMATCH を返す。

export type CatalogValidationResult =
  | { readonly ok: true; readonly response: BattleSimulationCatalogResponse }
  | { readonly ok: false; readonly error: UiApiError };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const POSITION_APTITUDES = ["FRONT", "BACK"];

// apps/api/src/presentation/http/schemas/catalog/catalog-schema.ts の catalogUnitSummaryResponseSchema:
// positionAptitudes は FRONT/BACK のみを許容する enum で、1件以上必須。
function isPositionAptitudes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && POSITION_APTITUDES.includes(item))
  );
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
    isPositionAptitudes(value["positionAptitudes"])
  );
}

function isValidMemory(value: unknown): value is CatalogMemorySummary {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value["memoryDefinitionId"]) && isNonEmptyString(value["displayName"]);
}

// apps/api/.../catalog-schema.ts の catalogGearEffectResponseSchema。効果表を
// 公開しない旧APIとも組み合わせられるよう不在は許すが、届いた表が壊れている
// 場合は表示側でギア選択肢の一部だけが数値を失うため契約違反として扱う。
function isValidGearEffectValue(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["tier"]) &&
    isNonEmptyString(value["grade"]) &&
    typeof value["percentagePoints"] === "number" &&
    Number.isFinite(value["percentagePoints"])
  );
}

function isValidGearEffect(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["stat"]) &&
    isNonEmptyString(value["application"]) &&
    Array.isArray(value["values"]) &&
    value["values"].every(isValidGearEffectValue)
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

  const gearEffects = body["gearEffects"];
  if (gearEffects !== undefined) {
    if (!Array.isArray(gearEffects) || !gearEffects.every(isValidGearEffect)) {
      return mismatch("Catalog response gearEffects is malformed.");
    }
  }

  return {
    ok: true,
    response: {
      schemaVersion: 1,
      catalogRevision: body["catalogRevision"],
      units,
      memories,
      ...(gearEffects === undefined ? {} : { gearEffects }),
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

// `result`以外は戦闘POSTと演習POSTで同一構造（10_API設計.md
// 「TacticalExerciseResponse」）。ラベルだけを差し替えて両方から使う。
type BattleLogStructuralResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly message: string };

function structuralMismatch(message: string): BattleLogStructuralResult {
  return { ok: false, message };
}

function validateBattleLogResponse(body: unknown, label: string): BattleLogStructuralResult {
  if (!isRecord(body)) {
    return structuralMismatch(`${label} response body is not a JSON object.`);
  }

  if (typeof body["schemaVersion"] !== "number") {
    return structuralMismatch(`${label} response schemaVersion is not a number.`);
  }
  if (!isNonEmptyString(body["battleId"])) {
    return structuralMismatch(`${label} response battleId is missing or empty.`);
  }
  if (!isNonEmptyString(body["catalogRevision"])) {
    return structuralMismatch(`${label} response catalogRevision is missing or empty.`);
  }
  if (!isValidBattleState(body["initialState"])) {
    return structuralMismatch(`${label} response initialState.units is malformed.`);
  }
  if (!isValidBattleState(body["finalState"])) {
    return structuralMismatch(`${label} response finalState.units is malformed.`);
  }
  if (!hasMatchingFinalStateUnits(body["initialState"], body["finalState"])) {
    return structuralMismatch(
      `${label} response finalState is missing a battleUnitId present in initialState.`,
    );
  }
  if (!Array.isArray(body["events"])) {
    return structuralMismatch(`${label} response events is not an array.`);
  }
  if (!Array.isArray(body["stateTransitions"])) {
    return structuralMismatch(`${label} response stateTransitions is not an array.`);
  }
  return { ok: true, result: body["result"] };
}

export function validateSimulationResponse(body: unknown): SimulationValidationResult {
  const structural = validateBattleLogResponse(body, "Simulation");
  if (!structural.ok) {
    return simulationMismatch(structural.message);
  }
  if (!isValidResult(structural.result)) {
    return simulationMismatch("Simulation response result is malformed.");
  }

  return {
    ok: true,
    response: body as BattleSimulationResponse,
  };
}

// docs/ui-design/03_API・データ連携設計.md §2.3 / UI-API-015: 演習の`result`だけを
// 追加で検証する。総スコア・ブレイク回数・ブレイク履歴は整数であり、`breaks`の
// 件数は`breakCount`と一致する（10_API設計.md「ExerciseResultResponse」）。

export type TacticalExerciseValidationResult =
  | { readonly ok: true; readonly response: TacticalExerciseResponse }
  | { readonly ok: false; readonly error: UiApiError };

function exerciseMismatch(message: string): TacticalExerciseValidationResult {
  return { ok: false, error: { kind: "RESPONSE_CONTRACT_MISMATCH", message } };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidBreak(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonNegativeInteger(value["breakNumber"]) &&
    isNonNegativeInteger(value["turnNumber"]) &&
    isNonNegativeInteger(value["cumulativeScoreAtBreak"])
  );
}

function isValidExerciseResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const breaks = value["breaks"];
  return (
    isNonEmptyString(value["completionReason"]) &&
    isNonNegativeInteger(value["completedTurn"]) &&
    isNonNegativeInteger(value["totalScore"]) &&
    isNonNegativeInteger(value["breakCount"]) &&
    Array.isArray(breaks) &&
    breaks.every(isValidBreak) &&
    breaks.length === value["breakCount"]
  );
}

export function validateTacticalExerciseResponse(body: unknown): TacticalExerciseValidationResult {
  const structural = validateBattleLogResponse(body, "Tactical exercise");
  if (!structural.ok) {
    return exerciseMismatch(structural.message);
  }
  if (!isValidExerciseResult(structural.result)) {
    return exerciseMismatch("Tactical exercise response result is malformed.");
  }

  return {
    ok: true,
    response: body as TacticalExerciseResponse,
  };
}

// docs/ui-design/03_API・データ連携設計.md §9.1: プレビューレスポンスの検証。
// 契約違反は`RESPONSE_CONTRACT_MISMATCH`として扱うが、戦闘実行は止めない
// （§2.5。プレビュー表示だけを取り下げる）。

export type FormationStatPreviewValidationResult =
  | { readonly ok: true; readonly response: FormationStatPreviewResponse }
  | { readonly ok: false; readonly error: UiApiError };

const PREVIEW_COMBAT_STATS = [
  "attack",
  "defense",
  "criticalRate",
  "actionSpeed",
  "affinityBonus",
  "criticalDamageBonus",
] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPreviewCombatStats(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return PREVIEW_COMBAT_STATS.every((stat) => isFiniteNumber(value[stat]));
}

function isValidPreviewPosition(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["column"] === "number" && isNonEmptyString(value["row"]);
}

function isValidPreviewUnit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["side"]) &&
    isNonEmptyString(value["unitDefinitionId"]) &&
    isValidPreviewPosition(value["formationPosition"]) &&
    isFiniteNumber(value["maximumHp"]) &&
    isValidPreviewCombatStats(value["combatStats"])
  );
}

export function validateFormationStatPreviewResponse(
  body: unknown,
): FormationStatPreviewValidationResult {
  const previewMismatch = (message: string): FormationStatPreviewValidationResult => ({
    ok: false,
    error: { kind: "RESPONSE_CONTRACT_MISMATCH", message },
  });

  if (!isRecord(body)) {
    return previewMismatch("Formation stat preview response body is not a JSON object.");
  }
  if (typeof body["schemaVersion"] !== "number") {
    return previewMismatch("Formation stat preview response schemaVersion is not a number.");
  }
  if (!isNonEmptyString(body["catalogRevision"])) {
    return previewMismatch("Formation stat preview response catalogRevision is missing or empty.");
  }
  const units = body["units"];
  if (!Array.isArray(units)) {
    return previewMismatch("Formation stat preview response units is not an array.");
  }
  if (!units.every(isValidPreviewUnit)) {
    return previewMismatch("Formation stat preview response contains a malformed unit entry.");
  }

  return { ok: true, response: body as unknown as FormationStatPreviewResponse };
}
