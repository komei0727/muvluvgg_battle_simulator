import {
  caseIdDocSchema,
  evaluationCaseResponseSchema,
  evaluationRequestCommonDocProperties,
  evaluationRequestCommonProperties,
  evaluationResponseHeaderDocProperties,
  evaluationResponseHeaderProperties,
  evaluationResponseHeaderRequired,
  evaluationUnitRecordResponseSchema,
  runIndicesDocSchema,
} from "./battle-evaluation-schema.js";
import { formationRequestDocSchema, formationRequestSchema } from "./simulation-schema.js";

/**
 * `POST /api/v1/tactical-exercise-evaluations`のJSON Schema（`10_API設計.md`「戦術演習を
 * 大量試行する」）。ケース数・試行数の上限は設定（`TACTICAL_EXERCISE_EVALUATION_*`環境変数）で
 * 変わり、`runIndices`の範囲・重複、`caseId`の一意性、敵編成の人数も他の値域違反と同じく
 * `422 INVALID_COMMAND`で返すため、実行時schemaでは件数・範囲を絞らない。演習は規定ターン数が
 * 固定（R-TEX-01 #4）のため`turnLimit`を持たず、`additionalProperties: false`が拒否する。
 */
const tacticalExerciseEvaluationCaseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["caseId", "allyFormation", "enemyFormation", "runIndices"],
  properties: {
    caseId: { type: "string" },
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
    runIndices: { type: "array", items: { type: "integer" } },
  },
} as const;

export const tacticalExerciseEvaluationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["seed", "cases"],
  properties: {
    ...evaluationRequestCommonProperties,
    cases: { type: "array", items: tacticalExerciseEvaluationCaseRequestSchema },
  },
} as const;

export const tacticalExerciseEvaluationRequestDocSchema = {
  ...tacticalExerciseEvaluationRequestSchema,
  properties: {
    ...evaluationRequestCommonDocProperties,
    cases: {
      type: "array",
      minItems: 1,
      items: {
        ...tacticalExerciseEvaluationCaseRequestSchema,
        properties: {
          caseId: caseIdDocSchema,
          allyFormation: formationRequestDocSchema,
          enemyFormation: {
            ...formationRequestDocSchema,
            description:
              "Exactly one EXERCISE_ENEMY unit and no memories (R-TEX-01 #3); violations return 422 INVALID_COMMAND.",
          },
          runIndices: runIndicesDocSchema,
        },
      },
    },
  },
} as const;

/** `10_API設計.md`「AllyUnitBreakCountResponse」。 */
const allyUnitBreakCountResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unitIndex", "unitDefinitionId", "breakCount"],
  properties: {
    unitIndex: { type: "integer", minimum: 0 },
    unitDefinitionId: { type: "string" },
    breakCount: { type: "integer", minimum: 0 },
  },
} as const;

const tacticalExerciseEvaluationRunResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "runIndex",
    "totalScore",
    "breakCount",
    "completionReason",
    "completedTurn",
    "units",
    "allyUnitBreaks",
  ],
  properties: {
    runIndex: { type: "integer", minimum: 0 },
    totalScore: { type: "integer", minimum: 0 },
    breakCount: { type: "integer", minimum: 0 },
    completionReason: { type: "string", enum: ["ALLY_DEFEATED", "TURN_LIMIT_REACHED"] },
    completedTurn: { type: "integer", minimum: 1 },
    units: { type: "array", items: evaluationUnitRecordResponseSchema },
    allyUnitBreaks: { type: "array", items: allyUnitBreakCountResponseSchema },
  },
} as const;

export const tacticalExerciseEvaluationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: evaluationResponseHeaderRequired,
  properties: {
    ...evaluationResponseHeaderProperties,
    cases: {
      type: "array",
      items: evaluationCaseResponseSchema(tacticalExerciseEvaluationRunResponseSchema),
    },
  },
} as const;

const tacticalExerciseEvaluationRunResponseDocSchema = {
  ...tacticalExerciseEvaluationRunResponseSchema,
  properties: {
    ...tacticalExerciseEvaluationRunResponseSchema.properties,
    allyUnitBreaks: {
      ...tacticalExerciseEvaluationRunResponseSchema.properties.allyUnitBreaks,
      description:
        "Breaks caused by each ally slot, one entry per requested allyFormation unit (unitIndex). Only breaks whose source is an ally slot are counted, so the entries sum to at most breakCount; the difference covers both breaks with no source unit (Memory-derived continuous damage) and breaks the enemy caused itself.",
    },
  },
} as const;

export const tacticalExerciseEvaluationResponseDocSchema = {
  ...tacticalExerciseEvaluationResponseSchema,
  properties: {
    ...evaluationResponseHeaderDocProperties,
    cases: {
      type: "array",
      items: evaluationCaseResponseSchema(tacticalExerciseEvaluationRunResponseDocSchema),
    },
  },
} as const;
