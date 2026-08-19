import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogMemorySummary,
  CatalogUnitSummary,
  FormationStatPreviewResponse,
  TacticalExerciseEvaluationResponse,
  TacticalExerciseResponse,
  UiApiError,
} from "./api-contract.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import { EXERCISE_TURN_LIMIT } from "../exercise/exercise-draft-validation.js";

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

// R-TEX-11 #1 #4: `gearEffects`と同じく、この2項目を返さない旧APIと組み合わせても
// 壊さないため不在を許す。届いた場合に型が違えば編成プールの判定を誤るため
// （`category`不在は`PLAYABLE`扱いになる）、契約違反として扱う。
function isValidOptionalCategory(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isValidOptionalExerciseActive(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isValidUnit(value: unknown): value is CatalogUnitSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["unitDefinitionId"]) &&
    isNonEmptyString(value["displayName"]) &&
    isNonEmptyString(value["characterName"]) &&
    isValidOptionalCategory(value["category"]) &&
    isValidOptionalExerciseActive(value["exerciseActive"]) &&
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

function isIntegerInRange(value: unknown, minimum: number, maximum?: number): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    return false;
  }
  return maximum === undefined || value <= maximum;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// docs/ddd/10_API設計.md「UnitBattleSummaryResponse」。集計量はinteger、HPは
// 「0以上の有限number」（丸めない）という公開契約に合わせる。
function isValidUnitSummary(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["battleUnitId"]) &&
    isNonEmptyString(value["side"]) &&
    isNonEmptyString(value["combatStatus"]) &&
    isIntegerInRange(value["damageDealt"], 0) &&
    isIntegerInRange(value["damageTaken"], 0) &&
    isIntegerInRange(value["healingDone"], 0) &&
    isNonNegativeNumber(value["finalHp"]) &&
    isNonNegativeNumber(value["maximumHp"])
  );
}

/**
 * `10_API設計.md`「UnitBattleSummaryResponse」: 参加ユニット**全件をちょうど1行ずつ**
 * 含む。サマリー表はRosterの全行をこの配列から描くため、対応が1対1でないと表示が
 * 静かに壊れる。
 *
 * - 行が足りない: その枠だけが警告なく0表示になる（クライアント集計時代の既知の
 *   不具合と同じ見え方）。
 * - 同じ`battleUnitId`が複数ある: `summary-projector.ts`の`Map`変換で後の行が
 *   無警告で勝ち、矛盾した集計値が「正しい値」として表示される。
 * - Rosterに無い`battleUnitId`がある: どの行にも現れず、集計の一部が黙って消える。
 *
 * 包含だけでは重複と余剰を通してしまうため、件数・IDの一意性・Rosterとの完全一致を
 * それぞれ確認する。
 *
 * 配列順もAPI契約は定めている（同「配列順は`BattleStateResponse.units`と同じ」）が、
 * この最小validatorは順序違反だけでは拒否しない。UIは`battleUnitId`で結合し表の
 * 並びはRosterが決めるため、順序が違っても表示は壊れない — §9の方針どおり、
 * 表示が成立するレスポンスをOpenAPIの厳密な再実装で拒否しない。
 */
function matchesRosterExactlyOnce(
  initialState: unknown,
  unitSummaries: readonly unknown[],
): boolean {
  if (!isRecord(initialState)) {
    return false;
  }
  const initialUnits = initialState["units"];
  if (!Array.isArray(initialUnits)) {
    return false;
  }
  const summarizedIds = unitSummaries
    .map(battleUnitIdOf)
    .filter((id): id is string => id !== undefined);
  if (summarizedIds.length !== unitSummaries.length) {
    return false;
  }
  const uniqueSummarizedIds = new Set(summarizedIds);
  if (uniqueSummarizedIds.size !== summarizedIds.length) {
    return false;
  }
  const rosterIds = initialUnits.map(battleUnitIdOf).filter((id): id is string => id !== undefined);
  if (rosterIds.length !== initialUnits.length) {
    return false;
  }
  // Rosterは同じ`battleUnitId`を持たない（戦闘内で一意）。件数一致と包含の
  // 両方を見れば、過不足のない1対1になる。
  return (
    uniqueSummarizedIds.size === new Set(rosterIds).size &&
    rosterIds.every((battleUnitId) => uniqueSummarizedIds.has(battleUnitId))
  );
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
  // ログ方針刷新3/3でサーバーは`SUMMARY`実行の`finalState`を省略する。不在は
  // 受理し、届いた場合だけ従来どおりshapeとroster対応を検証する——存在するのに
  // 壊れているのは、表示層まで通してはいけない契約違反のままである。
  if (body["finalState"] !== undefined) {
    if (!isValidBattleState(body["finalState"])) {
      return structuralMismatch(`${label} response finalState.units is malformed.`);
    }
    if (!hasMatchingFinalStateUnits(body["initialState"], body["finalState"])) {
      return structuralMismatch(
        `${label} response finalState is missing a battleUnitId present in initialState.`,
      );
    }
  }
  const unitSummaries = body["unitSummaries"];
  if (!Array.isArray(unitSummaries) || !unitSummaries.every(isValidUnitSummary)) {
    return structuralMismatch(`${label} response unitSummaries is missing or malformed.`);
  }
  if (!matchesRosterExactlyOnce(body["initialState"], unitSummaries)) {
    return structuralMismatch(
      `${label} response unitSummaries does not contain exactly one entry per initialState battleUnitId.`,
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
//
// 値域はサーバーのschema（apps/api/.../simulation/tactical-exercise-schema.ts）を
// そのまま写す。ターン番号とブレイク番号は1始まりで、演習は5ターン固定
// （`R-TEX-01` #4）であるため、0や上限超過はUIが表示してよい結果ではない。
// UIが独自に厳しくしているのではなく、公開契約の値域に一致させている。

export type TacticalExerciseValidationResult =
  | { readonly ok: true; readonly response: TacticalExerciseResponse }
  | { readonly ok: false; readonly error: UiApiError };

function exerciseMismatch(message: string): TacticalExerciseValidationResult {
  return { ok: false, error: { kind: "RESPONSE_CONTRACT_MISMATCH", message } };
}

function isValidBreak(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  // R-MEM-04: 発生源ユニットを持たないブレイクがあるため`sourceUnitDefinitionId`は
  // 任意項目にする。不在は「メモリー由来」という意味を持つ正常値であり、この項目
  // より前にデプロイされたAPIの応答もそのまま受理する。
  const sourceUnitDefinitionId = value["sourceUnitDefinitionId"];
  return (
    // breakNumberに上限は無い（1体を何度でもブレイクし得る）。
    isIntegerInRange(value["breakNumber"], 1) &&
    isIntegerInRange(value["turnNumber"], 1, EXERCISE_TURN_LIMIT) &&
    isIntegerInRange(value["cumulativeScoreAtBreak"], 0) &&
    (sourceUnitDefinitionId === undefined || isNonEmptyString(sourceUnitDefinitionId))
  );
}

function isValidExerciseResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const breaks = value["breaks"];
  return (
    isNonEmptyString(value["completionReason"]) &&
    isIntegerInRange(value["completedTurn"], 1, EXERCISE_TURN_LIMIT) &&
    isIntegerInRange(value["totalScore"], 0) &&
    isIntegerInRange(value["breakCount"], 0) &&
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

// docs/ddd/10_API設計.md「TacticalExerciseEvaluationResponse」: 統計実行の一括評価。
// 統計量は返らず、UIが試行ごとの生値から集計する。集計は添字の対応（同じ添字が同じ
// 試行、ユニット別配列の列が編成順の枠）に全面的に依存するため、長さの整合を
// ここで確かめ、対応が崩れた応答を統計へ流さない。

export type TacticalExerciseEvaluationValidationResult =
  | { readonly ok: true; readonly response: TacticalExerciseEvaluationResponse }
  | { readonly ok: false; readonly error: UiApiError };

/** 候補は常に1件で送る（`exercise-request-mapper.ts`）ため、応答も1件でなければ対応が取れない。 */
const EVALUATION_CANDIDATE_COUNT = 1;

function isIntegerArrayOfLength(value: unknown, length: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => isIntegerInRange(item, 0))
  );
}

function isStringArrayOfLength(value: unknown, length: number): value is readonly string[] {
  return Array.isArray(value) && value.length === length && value.every(isNonEmptyString);
}

/**
 * 試行×ユニットの行列。行数は`completedRuns`、列数は編成のユニット数で、試行が変わっても
 * 列数は変わらない。列数が試行ごとに違うと、どの列がどのユニットか決められない。
 */
function unitColumnCount(value: unknown, runs: number): number | undefined {
  if (!Array.isArray(value) || value.length !== runs) {
    return undefined;
  }
  const rows: readonly unknown[] = value;
  const first = rows[0];
  const columns = Array.isArray(first) ? first.length : 0;
  return rows.every((row) => isIntegerArrayOfLength(row, columns)) ? columns : undefined;
}

function isValidEvaluationCandidate(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const completedRuns = value["completedRuns"];
  if (!isIntegerInRange(completedRuns, 0)) {
    return false;
  }
  if (
    !isIntegerArrayOfLength(value["scores"], completedRuns) ||
    !isIntegerArrayOfLength(value["breakCounts"], completedRuns) ||
    !isIntegerArrayOfLength(value["completedTurns"], completedRuns) ||
    !isStringArrayOfLength(value["completionReasons"], completedRuns)
  ) {
    return false;
  }
  const damageColumns = unitColumnCount(value["allyUnitDamageTotals"], completedRuns);
  const breakColumns = unitColumnCount(value["allyUnitBreakCounts"], completedRuns);
  return damageColumns !== undefined && damageColumns === breakColumns;
}

export function validateTacticalExerciseEvaluationResponse(
  body: unknown,
): TacticalExerciseEvaluationValidationResult {
  const evaluationMismatch = (message: string): TacticalExerciseEvaluationValidationResult => ({
    ok: false,
    error: { kind: "RESPONSE_CONTRACT_MISMATCH", message },
  });

  if (!isRecord(body)) {
    return evaluationMismatch("Tactical exercise evaluation response body is not a JSON object.");
  }
  if (typeof body["schemaVersion"] !== "number") {
    return evaluationMismatch(
      "Tactical exercise evaluation response schemaVersion is not a number.",
    );
  }
  if (!isNonEmptyString(body["catalogRevision"])) {
    return evaluationMismatch(
      "Tactical exercise evaluation response catalogRevision is missing or empty.",
    );
  }
  // seedは再現の鍵であり、欠けた応答は「どの実行の結果か」を失う（Q-TEX-17）。
  if (!isNonEmptyString(body["seed"])) {
    return evaluationMismatch("Tactical exercise evaluation response seed is missing or empty.");
  }
  if (!isIntegerInRange(body["runsPerCandidate"], 1)) {
    return evaluationMismatch(
      "Tactical exercise evaluation response runsPerCandidate is not a positive integer.",
    );
  }
  const candidates = body["candidates"];
  if (!Array.isArray(candidates) || candidates.length !== EVALUATION_CANDIDATE_COUNT) {
    return evaluationMismatch(
      "Tactical exercise evaluation response does not carry exactly one candidate.",
    );
  }
  if (!candidates.every(isValidEvaluationCandidate)) {
    return evaluationMismatch(
      "Tactical exercise evaluation response candidate arrays do not agree with completedRuns.",
    );
  }

  return { ok: true, response: body as unknown as TacticalExerciseEvaluationResponse };
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

/**
 * `enhancedBaseStats`（R-ENH-06の強化後基本ステータス）は不在を正常系として扱う。
 * APIとUIは別々にデプロイされ、切替中は本フィールドを持たないサーバーの応答も
 * 届き得るため（`10_API設計.md`「ローリングデプロイ中の可用性」）。不在で応答全体を
 * 契約違反にすると、補正後のプレビューまで巻き添えで消える。
 *
 * ただし**存在するのに壊れている**場合は契約違反とする —— 欠けた項目だけが
 * 抜けた表示になり、利用者からは補正前の値として正しく見えてしまうため。
 */
function isValidPreviewBaseStats(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isValidPreviewCombatStats(value) &&
    isFiniteNumber((value as Record<string, unknown>)["maximumHp"])
  );
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
    isValidPreviewCombatStats(value["combatStats"]) &&
    isValidPreviewBaseStats(value["enhancedBaseStats"])
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
