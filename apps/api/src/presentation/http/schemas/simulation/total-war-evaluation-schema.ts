import {
  caseIdDocSchema,
  completionReasonResponseSchema,
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
import {
  defeatedFormationCountsResponseSchema,
  totalWarStageResponseSchema,
} from "../battle-log/battle-log-schema.js";

/**
 * `POST /api/v1/total-war-evaluations`のJSON Schema（`10_API設計.md`「総力戦を大量試行する」）。
 * 編成数1～3件・試行番号の範囲などは単発の総力戦と同じく`422`で返すため実行時schemaでは
 * 絞らない。`turnLimit`は持たず、`additionalProperties: false`が構造違反として拒否する。
 */
const totalWarEvaluationCaseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["caseId", "allyFormations", "enemyFormations", "runIndices"],
  properties: {
    caseId: { type: "string" },
    allyFormations: { type: "array", items: formationRequestSchema },
    enemyFormations: { type: "array", items: formationRequestSchema },
    runIndices: { type: "array", items: { type: "integer" } },
  },
} as const;

export const totalWarEvaluationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["seed", "cases"],
  properties: {
    ...evaluationRequestCommonProperties,
    cases: { type: "array", items: totalWarEvaluationCaseRequestSchema },
  },
} as const;

const formationListRequestDocSchema = {
  type: "array",
  items: formationRequestDocSchema,
  minItems: 1,
  maxItems: 3,
  description: "Formations in deployment order.",
} as const;

export const totalWarEvaluationRequestDocSchema = {
  ...totalWarEvaluationRequestSchema,
  properties: {
    ...evaluationRequestCommonDocProperties,
    cases: {
      type: "array",
      minItems: 1,
      items: {
        ...totalWarEvaluationCaseRequestSchema,
        properties: {
          caseId: caseIdDocSchema,
          allyFormations: formationListRequestDocSchema,
          enemyFormations: formationListRequestDocSchema,
          runIndices: runIndicesDocSchema,
        },
      },
    },
  },
} as const;

const totalWarEvaluationUnitRecordResponseSchema = {
  ...evaluationUnitRecordResponseSchema,
  required: [
    ...evaluationUnitRecordResponseSchema.required,
    "formationNumber",
    "deployed",
    "reappearance",
  ],
} as const;

const totalWarEvaluationRunResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "runIndex",
    "outcome",
    "completionReason",
    "completedTurn",
    "stages",
    "defeatedFormationCounts",
    "units",
  ],
  properties: {
    runIndex: { type: "integer", minimum: 0 },
    outcome: { type: "string", enum: ["ALLY_WIN", "ALLY_LOSE", "DRAW"] },
    completionReason: completionReasonResponseSchema,
    completedTurn: { type: "integer", minimum: 1 },
    stages: { type: "array", items: totalWarStageResponseSchema },
    defeatedFormationCounts: defeatedFormationCountsResponseSchema,
    units: { type: "array", items: totalWarEvaluationUnitRecordResponseSchema },
  },
} as const;

export const totalWarEvaluationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: evaluationResponseHeaderRequired,
  properties: {
    ...evaluationResponseHeaderProperties,
    cases: {
      type: "array",
      items: evaluationCaseResponseSchema(totalWarEvaluationRunResponseSchema),
    },
  },
} as const;

export const totalWarEvaluationResponseDocSchema = {
  ...totalWarEvaluationResponseSchema,
  properties: {
    ...evaluationResponseHeaderDocProperties,
    cases: totalWarEvaluationResponseSchema.properties.cases,
  },
} as const;
