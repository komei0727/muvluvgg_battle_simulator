import { formationRequestDocSchema, formationRequestSchema } from "./simulation-schema.js";

/**
 * `POST /api/v1/battle-evaluations`のJSON Schema（`10_API設計.md`「通常戦闘を大量試行する」）。
 *
 * 編成の要素は単発の戦闘schemaをそのまま再利用する。ケース数・試行数の上限は設定
 * （`BATTLE_EVALUATION_*`環境変数）で変わり、`runIndices`の範囲・重複、`caseId`の一意性、
 * `turnLimit`の値域も他の値域違反と同じく`422 INVALID_COMMAND`で返すため、実行時schemaでは
 * 件数・範囲を絞らない。値域は公開文書側（`*DocSchema`）だけが持つ。
 */
export const battleEvaluationCaseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["caseId", "allyFormation", "enemyFormation", "turnLimit", "runIndices"],
  properties: {
    caseId: { type: "string" },
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
    turnLimit: { type: "integer" },
    runIndices: { type: "array", items: { type: "integer" } },
  },
} as const;

/** 通常戦闘・総力戦で共通のトップレベル項目。 */
export const evaluationRequestCommonProperties = {
  seed: { type: "string" },
  expectedCatalogRevision: { type: "string" },
  expectedEngineRevision: { type: "string" },
} as const;

export const battleEvaluationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["seed", "cases"],
  properties: {
    ...evaluationRequestCommonProperties,
    cases: { type: "array", items: battleEvaluationCaseRequestSchema },
  },
} as const;

export const runIndicesDocSchema = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: { type: "integer", minimum: 0, maximum: 4294967295 },
  description:
    "Run numbers to execute for this case. Each run index alone (with the seed) selects the random stream, so the same index reproduces the same run and gaps such as [0, 1, 42] are allowed.",
} as const;

export const caseIdDocSchema = {
  type: "string",
  minLength: 1,
  description: "Identifies the case in the response. Must be unique within the request.",
} as const;

export const evaluationRequestCommonDocProperties = {
  seed: {
    type: "string",
    minLength: 1,
    description:
      "Required. Together with each runIndex it fully determines the random stream; the server never generates one.",
  },
  expectedCatalogRevision: {
    type: "string",
    minLength: 1,
    description:
      "When set, the request is rejected with 422 INVALID_COMMAND (path expectedCatalogRevision) before any run if the server catalogRevision differs.",
  },
  expectedEngineRevision: {
    type: "string",
    minLength: 1,
    description:
      "When set, the request is rejected with 422 INVALID_COMMAND (path expectedEngineRevision) before any run if the server engineRevision differs.",
  },
} as const;

export const battleEvaluationRequestDocSchema = {
  ...battleEvaluationRequestSchema,
  properties: {
    ...evaluationRequestCommonDocProperties,
    cases: {
      type: "array",
      minItems: 1,
      items: {
        ...battleEvaluationCaseRequestSchema,
        properties: {
          caseId: caseIdDocSchema,
          allyFormation: formationRequestDocSchema,
          enemyFormation: formationRequestDocSchema,
          turnLimit: { type: "integer", minimum: 1, maximum: 99 },
          runIndices: runIndicesDocSchema,
        },
      },
    },
  },
} as const;

/**
 * `10_API設計.md`「EvaluationUnitRecordResponse」。`formationNumber`・`deployed`・
 * `reappearance`は総力戦だけが持つ。
 */
export const evaluationUnitRecordResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "side",
    "unitIndex",
    "unitDefinitionId",
    "damageDealt",
    "damageTaken",
    "healingDone",
    "finalHp",
    "maximumHp",
    "combatStatus",
  ],
  properties: {
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    formationNumber: { type: "integer", minimum: 1, maximum: 3 },
    unitIndex: { type: "integer", minimum: 0 },
    unitDefinitionId: { type: "string" },
    damageDealt: { type: "integer", minimum: 0 },
    damageTaken: { type: "integer", minimum: 0 },
    healingDone: { type: "integer", minimum: 0 },
    // HPは単発応答と同じく端数を持ち得る（`unitBattleSummaryResponseSchema`の注記）。
    finalHp: { type: "number", minimum: 0 },
    maximumHp: { type: "number", minimum: 0 },
    combatStatus: { type: "string", enum: ["ACTIVE", "DEFEATED"] },
    deployed: { type: "boolean" },
    reappearance: { type: "boolean" },
  },
} as const;

export const completionReasonResponseSchema = {
  type: "string",
  enum: ["SIMULTANEOUS_DEFEAT", "ENEMY_DEFEATED", "ALLY_DEFEATED", "TURN_LIMIT_REACHED"],
} as const;

const battleEvaluationRunResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runIndex", "outcome", "completionReason", "completedTurn", "units"],
  properties: {
    runIndex: { type: "integer", minimum: 0 },
    outcome: { type: "string", enum: ["ALLY_WIN", "ALLY_LOSE"] },
    completionReason: completionReasonResponseSchema,
    completedTurn: { type: "integer", minimum: 1 },
    units: { type: "array", items: evaluationUnitRecordResponseSchema },
  },
} as const;

/** `10_API設計.md`「EvaluationCaseResponse」。 */
export function evaluationCaseResponseSchema<Run extends object>(runSchema: Run) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["caseId", "runs", "incompleteRunIndices"],
    properties: {
      caseId: { type: "string" },
      runs: { type: "array", items: runSchema },
      incompleteRunIndices: { type: "array", items: { type: "integer", minimum: 0 } },
    },
  } as const;
}

/** `10_API設計.md`「EvaluationResponse」の共通ヘッダー。 */
export const evaluationResponseHeaderProperties = {
  schemaVersion: { type: "integer" },
  seed: { type: "string" },
  seedDerivationVersion: { type: "string" },
  catalogRevision: { type: "string" },
  engineRevision: { type: "string" },
  requestedRuns: { type: "integer", minimum: 1 },
  completedRuns: { type: "integer", minimum: 0 },
  partial: { type: "boolean" },
} as const;

export const evaluationResponseHeaderRequired = [
  "schemaVersion",
  "seed",
  "seedDerivationVersion",
  "catalogRevision",
  "engineRevision",
  "requestedRuns",
  "completedRuns",
  "partial",
  "cases",
] as const;

export const battleEvaluationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: evaluationResponseHeaderRequired,
  properties: {
    ...evaluationResponseHeaderProperties,
    cases: {
      type: "array",
      items: evaluationCaseResponseSchema(battleEvaluationRunResponseSchema),
    },
  },
} as const;

export const evaluationResponseHeaderDocProperties = {
  ...evaluationResponseHeaderProperties,
  partial: {
    type: "boolean",
    description:
      "True when the request deadline was reached before every requested run completed. Runs that did not complete are listed per case in incompleteRunIndices and are never reported as results.",
  },
  engineRevision: {
    type: "string",
    description:
      "Identifies the battle implementation that produced the runs, fixed at server start. Results are reproducible only for the same seed, runIndex, catalogRevision, engineRevision and seedDerivationVersion.",
  },
} as const;

export const battleEvaluationResponseDocSchema = {
  ...battleEvaluationResponseSchema,
  properties: {
    ...evaluationResponseHeaderDocProperties,
    cases: battleEvaluationResponseSchema.properties.cases,
  },
} as const;
