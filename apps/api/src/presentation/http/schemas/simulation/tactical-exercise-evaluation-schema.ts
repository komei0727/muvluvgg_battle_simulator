import { formationRequestDocSchema, formationRequestSchema } from "./simulation-schema.js";

/**
 * `10_API設計.md`「TacticalExerciseEvaluationRequest」。候補ごとの上限件数・総試行数は
 * 設定（`EVALUATION_*`環境変数）で変わるため、ここでは範囲を固定せず
 * `validateEvaluateTacticalExerciseCandidatesCommandShape`（422）へ委ねる——
 * schemaへ書くと設定を変えても400のまま拒否される。
 */
const candidateRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation"],
  properties: {
    allyFormation: formationRequestSchema,
  },
} as const;

export const tacticalExerciseEvaluationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enemyFormation", "candidates", "runsPerCandidate"],
  properties: {
    enemyFormation: formationRequestSchema,
    candidates: { type: "array", items: candidateRequestSchema },
    runsPerCandidate: { type: "integer" },
    seed: { type: "string" },
  },
} as const;

const candidateRequestDocSchema = {
  ...candidateRequestSchema,
  properties: {
    allyFormation: formationRequestDocSchema,
  },
} as const;

export const tacticalExerciseEvaluationRequestDocSchema = {
  ...tacticalExerciseEvaluationRequestSchema,
  properties: {
    ...tacticalExerciseEvaluationRequestSchema.properties,
    enemyFormation: formationRequestDocSchema,
    candidates: { type: "array", minItems: 1, items: candidateRequestDocSchema },
    runsPerCandidate: { type: "integer", minimum: 1 },
    seed: {
      type: "string",
      minLength: 1,
      description:
        "Reproduces a previous evaluation. Omit to let the server generate one; the response always echoes the seed actually used.",
    },
  },
} as const;

/**
 * `10_API設計.md`「TacticalExerciseCandidateEvaluationResponse」。6つの配列は同じ試行を
 * 同じ添字で指し、いずれも長さが`completedRuns`に一致する（期限到達で打ち切られた
 * 場合は`runsPerCandidate`より短くなる）。`allyUnit*`の内側はリクエストの
 * `allyFormation.units`と同じ長さ・同じ順である。
 */
const candidateEvaluationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "completedRuns",
    "scores",
    "breakCounts",
    "completedTurns",
    "completionReasons",
    "allyUnitDamageTotals",
    "allyUnitBreakCounts",
  ],
  properties: {
    completedRuns: { type: "integer" },
    scores: { type: "array", items: { type: "integer" } },
    breakCounts: { type: "array", items: { type: "integer" } },
    completedTurns: { type: "array", items: { type: "integer" } },
    completionReasons: { type: "array", items: { type: "string" } },
    allyUnitDamageTotals: {
      type: "array",
      items: { type: "array", items: { type: "integer" } },
    },
    allyUnitBreakCounts: {
      type: "array",
      items: { type: "array", items: { type: "integer" } },
    },
  },
} as const;

export const tacticalExerciseEvaluationResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "seed", "runsPerCandidate", "candidates"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string" },
    seed: { type: "string" },
    runsPerCandidate: { type: "integer" },
    candidates: { type: "array", items: candidateEvaluationResponseSchema },
  },
} as const;

const candidateEvaluationResponseDocSchema = {
  ...candidateEvaluationResponseSchema,
  properties: {
    ...candidateEvaluationResponseSchema.properties,
    completedRuns: {
      type: "integer",
      minimum: 0,
      description:
        "Number of runs that finished before the request deadline. Lower than runsPerCandidate when the deadline was reached.",
    },
    completionReasons: {
      type: "array",
      items: { type: "string", enum: ["ALLY_DEFEATED", "TURN_LIMIT_REACHED"] },
    },
    allyUnitDamageTotals: {
      ...candidateEvaluationResponseSchema.properties.allyUnitDamageTotals,
      description:
        "Damage each ally unit dealt, per run. One row per completed run, one column per requested allyFormation unit, in formation order.",
    },
    allyUnitBreakCounts: {
      ...candidateEvaluationResponseSchema.properties.allyUnitBreakCounts,
      description:
        "Breaks caused by each ally unit, per run. Only breaks whose source is an ally unit are counted, so each row sums to at most the same index of breakCounts; the difference covers both breaks with no source unit (Memory-derived continuous damage) and breaks the enemy caused itself.",
    },
  },
} as const;

export const tacticalExerciseEvaluationResponseDocSchema = {
  ...tacticalExerciseEvaluationResponseSchema,
  properties: {
    ...tacticalExerciseEvaluationResponseSchema.properties,
    candidates: {
      type: "array",
      items: candidateEvaluationResponseDocSchema,
      description: "One entry per request candidate, in request order.",
    },
  },
} as const;
