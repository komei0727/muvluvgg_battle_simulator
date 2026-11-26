// 腐敗防止層（Anti-Corruption Layer）。サーバーのレスポンスをTypeScript型だけで
// 信頼せず、契約違反ならUI表示より前に RESPONSE_CONTRACT_MISMATCH として落とす。
import { EXERCISE_TURN_LIMIT } from "../../entities/tactical-exercise.js";
import { TOTAL_WAR_MAX_FORMATIONS, TOTAL_WAR_TURN_LIMIT } from "../../entities/total-war.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
  CatalogEffectSummary,
  CatalogMemorySummary,
  CatalogSkillSummary,
  CatalogUnitSummary,
  FormationStatPreviewResponse,
  TacticalExerciseEvaluationResponse,
  TacticalExerciseResponse,
  TotalWarResponse,
  TotalWarUnitRosterResponse,
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

// apps/api/.../catalog-schema.ts の catalogSkillSummaryResponseSchema /
// catalogEffectSummaryResponseSchema。`gearEffects`と同じく、要約を公開しない旧APIとも
// 組み合わせられるよう不在は許し、届いた要約が壊れている場合は契約違反として扱う。
function isOptionalString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isValidSkillSummary(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["skillDefinitionId"]) &&
    isNonEmptyString(value["displayName"]) &&
    isNonEmptyString(value["skillType"]) &&
    isOptionalString(value["ownerUnitDefinitionId"]) &&
    isOptionalString(value["slotLabel"])
  );
}

function isValidEffectSummary(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const constantMagnitude = value["constantMagnitude"];
  return (
    isNonEmptyString(value["effectActionDefinitionId"]) &&
    isNonEmptyString(value["kind"]) &&
    ["stat", "valueType", "direction", "damageType", "status"].every((key) =>
      isOptionalString(value[key]),
    ) &&
    (constantMagnitude === undefined ||
      (typeof constantMagnitude === "number" && Number.isFinite(constantMagnitude)))
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

  const skills = body["skills"];
  if (skills !== undefined) {
    if (!Array.isArray(skills) || !skills.every(isValidSkillSummary)) {
      return mismatch("Catalog response skills is malformed.");
    }
  }

  const effects = body["effects"];
  if (effects !== undefined) {
    if (!Array.isArray(effects) || !effects.every(isValidEffectSummary)) {
      return mismatch("Catalog response effects is malformed.");
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
      ...(skills === undefined ? {} : { skills: skills as readonly CatalogSkillSummary[] }),
      ...(effects === undefined ? {} : { effects: effects as readonly CatalogEffectSummary[] }),
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
  return summariesMatchRosterExactlyOnce(initialUnits, unitSummaries);
}

/**
 * `matchesRosterExactlyOnce`の本体。Rosterの正本はモードで異なる（通常戦闘・戦術演習は
 * `initialState.units`、総力戦は`unitRoster`）ため、Roster行の配列を受け取る。
 */
function summariesMatchRosterExactlyOnce(
  rosterUnits: readonly unknown[],
  unitSummaries: readonly unknown[],
): boolean {
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
  const rosterIds = rosterUnits.map(battleUnitIdOf).filter((id): id is string => id !== undefined);
  if (rosterIds.length !== rosterUnits.length) {
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

/**
 * 3モードの成功レスポンスに共通し、Rosterの正本に依存しない検証。違反があれば
 * メッセージを、無ければ`undefined`を返す。
 */
function battleLogEnvelopeViolation(
  body: Record<string, unknown>,
  label: string,
): string | undefined {
  if (typeof body["schemaVersion"] !== "number") {
    return `${label} response schemaVersion is not a number.`;
  }
  if (!isNonEmptyString(body["battleId"])) {
    return `${label} response battleId is missing or empty.`;
  }
  if (!isNonEmptyString(body["catalogRevision"])) {
    return `${label} response catalogRevision is missing or empty.`;
  }
  if (!isValidBattleState(body["initialState"])) {
    return `${label} response initialState.units is malformed.`;
  }
  if (body["finalState"] !== undefined && !isValidBattleState(body["finalState"])) {
    return `${label} response finalState.units is malformed.`;
  }
  const unitSummaries = body["unitSummaries"];
  if (!Array.isArray(unitSummaries) || !unitSummaries.every(isValidUnitSummary)) {
    return `${label} response unitSummaries is missing or malformed.`;
  }
  if (!Array.isArray(body["events"])) {
    return `${label} response events is not an array.`;
  }
  if (!Array.isArray(body["stateTransitions"])) {
    return `${label} response stateTransitions is not an array.`;
  }
  return undefined;
}

function validateBattleLogResponse(body: unknown, label: string): BattleLogStructuralResult {
  if (!isRecord(body)) {
    return structuralMismatch(`${label} response body is not a JSON object.`);
  }

  const envelopeViolation = battleLogEnvelopeViolation(body, label);
  if (envelopeViolation !== undefined) {
    return structuralMismatch(envelopeViolation);
  }
  // ログ方針刷新3/3でサーバーは`SUMMARY`実行の`finalState`を省略する。不在は
  // 受理し、届いた場合だけ従来どおりshapeとroster対応を検証する——存在するのに
  // 壊れているのは、表示層まで通してはいけない契約違反のままである。
  if (
    body["finalState"] !== undefined &&
    !hasMatchingFinalStateUnits(body["initialState"], body["finalState"])
  ) {
    return structuralMismatch(
      `${label} response finalState is missing a battleUnitId present in initialState.`,
    );
  }
  // 形は`battleLogEnvelopeViolation`で検証済み。
  const unitSummaries = body["unitSummaries"] as readonly unknown[];
  if (!matchesRosterExactlyOnce(body["initialState"], unitSummaries)) {
    return structuralMismatch(
      `${label} response unitSummaries does not contain exactly one entry per initialState battleUnitId.`,
    );
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

// docs/ui-design/03_API・データ連携設計.md §9.2 / UI-API-049: 総力戦の成功レスポンス。
// `result`の形とRosterの正本（`initialState`ではなく`unitRoster`）が通常戦闘と異なるため、
// `validateSimulationResponse`へ分岐を足さず専用の関数にする——1つの関数で分岐させると、
// 通常戦闘の検証を総力戦の都合で緩めることになる。
//
// 値域はサーバーのschema（apps/api/.../simulation/total-war-schema.ts）を写す。列挙値
// （`outcome`・`completionReason`・`side`）は§9と同じく未知の値を許容する。

export type TotalWarValidationResult =
  | { readonly ok: true; readonly response: TotalWarResponse }
  | { readonly ok: false; readonly error: UiApiError };

function totalWarMismatch(message: string): TotalWarValidationResult {
  return { ok: false, error: { kind: "RESPONSE_CONTRACT_MISMATCH", message } };
}

function isFormationNumber(value: unknown): value is number {
  return isIntegerInRange(value, 1, TOTAL_WAR_MAX_FORMATIONS);
}

function isValidStage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const defeatedSides = value["defeatedSides"];
  return (
    isFormationNumber(value["allyFormationNumber"]) &&
    isFormationNumber(value["enemyFormationNumber"]) &&
    isIntegerInRange(value["startTurn"], 1, TOTAL_WAR_TURN_LIMIT) &&
    isIntegerInRange(value["endTurn"], 1, TOTAL_WAR_TURN_LIMIT) &&
    Array.isArray(defeatedSides) &&
    defeatedSides.every(isNonEmptyString)
  );
}

/** 戦闘履歴の行番号に使うため、`stageNumber`は1からの連番でなければならない。 */
function hasSequentialStageNumbers(stages: readonly unknown[]): boolean {
  return stages.every((stage, index) => isRecord(stage) && stage["stageNumber"] === index + 1);
}

function isValidDefeatedFormationCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIntegerInRange(value["ally"], 0, TOTAL_WAR_MAX_FORMATIONS) &&
    isIntegerInRange(value["enemy"], 0, TOTAL_WAR_MAX_FORMATIONS)
  );
}

function isValidTotalWarResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const stages = value["stages"];
  return (
    isNonEmptyString(value["outcome"]) &&
    isNonEmptyString(value["completionReason"]) &&
    isIntegerInRange(value["completedTurn"], 1, TOTAL_WAR_TURN_LIMIT) &&
    Array.isArray(stages) &&
    stages.length > 0 &&
    stages.every(isValidStage) &&
    hasSequentialStageNumbers(stages) &&
    isValidDefeatedFormationCounts(value["defeatedFormationCounts"])
  );
}

function isValidRosterEntry(value: unknown): value is TotalWarUnitRosterResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["battleUnitId"]) &&
    isNonEmptyString(value["unitDefinitionId"]) &&
    isNonEmptyString(value["side"]) &&
    isFormationNumber(value["formationNumber"]) &&
    isValidPreviewPosition(value["formationPosition"]) &&
    typeof value["reappearance"] === "boolean" &&
    typeof value["deployed"] === "boolean"
  );
}

function stateUnitIds(state: unknown): readonly string[] {
  const units = isRecord(state) ? state["units"] : undefined;
  return Array.isArray(units)
    ? units.map(battleUnitIdOf).filter((id): id is string => id !== undefined)
    : [];
}

/**
 * `initialState`は両陣営の1番目の編成だけ、`finalState`は出撃したことのある全ユニットを
 * 含む（10_API設計.md「TotalWarResponse」）。どちらに現れるユニットも`unitRoster`の
 * 出撃済みの行でなければならず、`finalState`は出撃済みの行をすべて含む。出撃しなかった
 * ユニットは`finalState`に現れないのが正しい（§10.1）。
 */
function statesHoldOnlyDeployedRosterUnits(
  body: Record<string, unknown>,
  roster: readonly TotalWarUnitRosterResponse[],
): boolean {
  const deployedIds = new Set(
    roster.filter((entry) => entry.deployed).map((entry) => entry.battleUnitId),
  );
  if (!stateUnitIds(body["initialState"]).every((id) => deployedIds.has(id))) {
    return false;
  }
  if (body["finalState"] === undefined) {
    return true;
  }
  const finalIds = stateUnitIds(body["finalState"]);
  return finalIds.every((id) => deployedIds.has(id)) && new Set(finalIds).size === deployedIds.size;
}

export function validateTotalWarResponse(body: unknown): TotalWarValidationResult {
  if (!isRecord(body)) {
    return totalWarMismatch("Total war response body is not a JSON object.");
  }
  const envelopeViolation = battleLogEnvelopeViolation(body, "Total war");
  if (envelopeViolation !== undefined) {
    return totalWarMismatch(envelopeViolation);
  }

  const roster = body["unitRoster"];
  if (!Array.isArray(roster) || !roster.every(isValidRosterEntry)) {
    return totalWarMismatch("Total war response unitRoster is missing or malformed.");
  }
  if (hasDuplicateIds(roster.map((entry) => entry.battleUnitId))) {
    return totalWarMismatch(
      "Total war response unitRoster contains duplicate battleUnitId values.",
    );
  }
  if (!summariesMatchRosterExactlyOnce(roster, body["unitSummaries"] as readonly unknown[])) {
    return totalWarMismatch(
      "Total war response unitSummaries does not contain exactly one entry per unitRoster battleUnitId.",
    );
  }
  if (!statesHoldOnlyDeployedRosterUnits(body, roster)) {
    return totalWarMismatch(
      "Total war response battle states do not match the deployed units of unitRoster.",
    );
  }
  if (!isValidTotalWarResult(body["result"])) {
    return totalWarMismatch("Total war response result is malformed.");
  }

  return { ok: true, response: body as unknown as TotalWarResponse };
}

// docs/ddd/10_API設計.md「TacticalExerciseEvaluationResponse」: 統計実行の大量試行。
// 統計量は返らず、UIが試行ごとのレコードから集計する。集計は「各要求番号が完了・未完了の
// どちらか一方にちょうど1回現れる」ことと「味方枠の`unitIndex`が編成順の0..n-1である」ことに
// 依存するため、その整合をここで確かめ、対応が崩れた応答を統計へ流さない。要求した番号の
// 集合と一致するかは、要求を知っている実行側（`use-exercise-statistics-run.ts`）が見る。

export type TacticalExerciseEvaluationValidationResult =
  | { readonly ok: true; readonly response: TacticalExerciseEvaluationResponse }
  | { readonly ok: false; readonly error: UiApiError };

/** ケースは常に1件で送る（`exercise-request-mapper.ts`）ため、応答も1件でなければ対応が取れない。 */
const EVALUATION_CASE_COUNT = 1;

const nonNegativeInteger = (value: unknown): value is number => isIntegerInRange(value, 0);

/**
 * 1試行の味方枠数。味方の`units`と`allyUnitBreaks`がどちらも`unitIndex`0..n-1を順に持つ
 * ときだけ数を返す — 番号が飛ぶ・食い違うと、列をどの枠へ付けるか決められない。
 */
function allyColumnCount(run: Record<string, unknown>): number | undefined {
  const units = run["units"];
  const breaks = run["allyUnitBreaks"];
  if (!Array.isArray(units) || !Array.isArray(breaks)) {
    return undefined;
  }
  const unitRecords: readonly unknown[] = units;
  const breakRecords: readonly unknown[] = breaks;
  if (
    !unitRecords.every(
      (unit) =>
        isRecord(unit) &&
        (unit["side"] === "ALLY" || unit["side"] === "ENEMY") &&
        nonNegativeInteger(unit["unitIndex"]) &&
        isNonEmptyString(unit["unitDefinitionId"]) &&
        nonNegativeInteger(unit["damageDealt"]),
    )
  ) {
    return undefined;
  }
  const allyIndices = unitRecords
    .filter((unit) => isRecord(unit) && unit["side"] === "ALLY")
    .map((unit) => (unit as Record<string, unknown>)["unitIndex"]);
  const breakIndices = breakRecords.map((entry) =>
    isRecord(entry) && nonNegativeInteger(entry["breakCount"]) ? entry["unitIndex"] : undefined,
  );
  const sequential = (indices: readonly unknown[]) =>
    indices.every((index, position) => index === position);
  return sequential(allyIndices) &&
    sequential(breakIndices) &&
    allyIndices.length === breakIndices.length
    ? allyIndices.length
    : undefined;
}

function isValidEvaluationRun(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    nonNegativeInteger(value["runIndex"]) &&
    nonNegativeInteger(value["totalScore"]) &&
    nonNegativeInteger(value["breakCount"]) &&
    nonNegativeInteger(value["completedTurn"]) &&
    isNonEmptyString(value["completionReason"])
  );
}

function evaluationCaseMismatch(caseBody: unknown): string | undefined {
  if (!isRecord(caseBody) || !isNonEmptyString(caseBody["caseId"])) {
    return "case is not an object with a caseId.";
  }
  const runs = caseBody["runs"];
  const incomplete = caseBody["incompleteRunIndices"];
  if (!Array.isArray(runs) || !Array.isArray(incomplete)) {
    return "case does not carry runs and incompleteRunIndices arrays.";
  }
  const runRecords: readonly unknown[] = runs;
  const incompleteIndices: readonly unknown[] = incomplete;
  if (!runRecords.every(isValidEvaluationRun) || !incompleteIndices.every(nonNegativeInteger)) {
    return "case runs or incomplete run indices are malformed.";
  }
  const columnCounts = runRecords.map((run) => allyColumnCount(run));
  if (columnCounts.some((count) => count === undefined || count !== columnCounts[0])) {
    return "case runs do not number their ally slots consistently.";
  }
  const reported = [...runRecords.map((run) => run["runIndex"]), ...incompleteIndices];
  if (new Set(reported).size !== reported.length) {
    return "case reports a run index more than once.";
  }
  return undefined;
}

export function validateTacticalExerciseEvaluationResponse(
  body: unknown,
): TacticalExerciseEvaluationValidationResult {
  const evaluationMismatch = (message: string): TacticalExerciseEvaluationValidationResult => ({
    ok: false,
    error: {
      kind: "RESPONSE_CONTRACT_MISMATCH",
      message: `Tactical exercise evaluation ${message}`,
    },
  });

  if (!isRecord(body)) {
    return evaluationMismatch("response body is not a JSON object.");
  }
  if (typeof body["schemaVersion"] !== "number") {
    return evaluationMismatch("response schemaVersion is not a number.");
  }
  // seed・各revisionは再現の鍵であり、欠けた応答は「どの条件の結果か」を失う。
  for (const field of ["seed", "seedDerivationVersion", "catalogRevision", "engineRevision"]) {
    if (!isNonEmptyString(body[field])) {
      return evaluationMismatch(`response ${field} is missing or empty.`);
    }
  }
  const cases = body["cases"];
  if (!Array.isArray(cases) || cases.length !== EVALUATION_CASE_COUNT) {
    return evaluationMismatch("response does not carry exactly one case.");
  }
  const caseList: readonly unknown[] = cases;
  for (const caseBody of caseList) {
    const mismatch = evaluationCaseMismatch(caseBody);
    if (mismatch !== undefined) {
      return evaluationMismatch(mismatch);
    }
  }
  const caseRecords = caseList as readonly Record<string, readonly unknown[]>[];
  const completed = caseRecords.reduce((total, caseBody) => total + caseBody["runs"]!.length, 0);
  const incomplete = caseRecords.reduce(
    (total, caseBody) => total + caseBody["incompleteRunIndices"]!.length,
    0,
  );
  if (
    body["completedRuns"] !== completed ||
    body["requestedRuns"] !== completed + incomplete ||
    body["partial"] !== incomplete > 0
  ) {
    return evaluationMismatch(
      "response completedRuns / requestedRuns / partial disagree with its runs.",
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
