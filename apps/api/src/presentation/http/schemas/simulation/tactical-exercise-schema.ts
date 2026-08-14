import {
  battleStateDeltaResponseSchema,
  battleStateResponseSchema,
  formationRequestDocSchema,
  formationRequestSchema,
  simulationOptionsRequestDocSchema,
  simulationOptionsRequestSchema,
  stateTransitionResponseSchema,
  unitBattleSummaryResponseSchema,
  unitStateDeltaResponseSchema,
  valueChangeNumberSchema,
} from "./simulation-schema.js";
import {
  battleLogEventResponseSchema,
  exerciseBattleLogEventResponseDocSchema,
} from "../battle-log/battle-log-schema.js";

/**
 * `POST /api/v1/tactical-exercises`のJSON Schema（`10_API設計.md`
 * 「戦術演習をシミュレーションする」）。
 *
 * 編成部分は戦闘シミュレーションのschemaをそのまま再利用する——同じ編成JSONが
 * 片方のエンドポイントでだけ通る状態を作らないため。`turnLimit`は持たず、
 * 未定義のトップレベルプロパティ（`turnLimit`を含む）は`additionalProperties: false`
 * が構造違反（`400 MALFORMED_REQUEST`）として拒否する。
 *
 * 実行時schemaが値域・列挙値を持たず公開文書側だけが持つ理由は
 * `simulation-schema.ts`冒頭の注記と同じ。敵編成の「ちょうど1体・メモリーなし」
 * （R-TEX-01 #3）も同じ扱いで、実行時schemaでは絞らずアプリケーション検証の
 * `422 INVALID_COMMAND`が返す。
 */
export const tacticalExerciseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation"],
  properties: {
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
    options: simulationOptionsRequestSchema,
  },
} as const;

/**
 * R-TEX-01 #3の敵編成制約を公開文書へ反映した編成schema。ユニットはちょうど1件、
 * メモリーは0件に固定する（実行時validationには使わない）。
 */
const exerciseEnemyFormationRequestDocSchema = {
  ...formationRequestDocSchema,
  properties: {
    ...formationRequestDocSchema.properties,
    units: { ...formationRequestDocSchema.properties.units, minItems: 1, maxItems: 1 },
    memoryDefinitionIds: {
      ...formationRequestDocSchema.properties.memoryDefinitionIds,
      maxItems: 0,
    },
  },
} as const;

export const tacticalExerciseRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation"],
  properties: {
    allyFormation: formationRequestDocSchema,
    enemyFormation: exerciseEnemyFormationRequestDocSchema,
    options: simulationOptionsRequestDocSchema,
  },
} as const;

/** `10_API設計.md`「ExerciseBreakResponse」（R-TEX-10 #2）。 */
const exerciseBreakResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["breakNumber", "turnNumber", "cumulativeScoreAtBreak"],
  properties: {
    breakNumber: { type: "integer", minimum: 1 },
    turnNumber: { type: "integer", minimum: 1, maximum: 5 },
    cumulativeScoreAtBreak: { type: "integer", minimum: 0 },
  },
} as const;

/**
 * `10_API設計.md`「ExerciseResultResponse」。`BattleResultResponse`と違い`outcome`を
 * 持たない——演習は勝敗を確定しない（R-TEX-10 #1）。終了理由も演習で起こり得る2つ
 * （規定ターン到達・味方全滅、R-TEX-09）だけに絞る。
 */
const exerciseResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["completionReason", "completedTurn", "totalScore", "breakCount", "breaks"],
  properties: {
    completionReason: { type: "string", enum: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"] },
    // R-TEX-01 #4: 規定ターン数は5固定。
    completedTurn: { type: "integer", minimum: 1, maximum: 5 },
    totalScore: { type: "integer", minimum: 0 },
    breakCount: { type: "integer", minimum: 0 },
    breaks: { type: "array", items: exerciseBreakResponseSchema },
  },
} as const;

/**
 * R-TEX-04のブレイク強化が書き換えた基礎戦闘ステータスの差分を加えた
 * `UnitStateDeltaResponse`。実効値の`combatStats`と違い`maximumHp`を含む——公開状態へ
 * 適用先を持たない監査用の差分であり、`hpMaximum`（実効値のHP上限）とは別物のため。
 */
const exerciseUnitStateDeltaResponseSchema = {
  ...unitStateDeltaResponseSchema,
  properties: {
    ...unitStateDeltaResponseSchema.properties,
    baseCombatStats: {
      type: "object",
      additionalProperties: false,
      properties: {
        maximumHp: valueChangeNumberSchema,
        attack: valueChangeNumberSchema,
        defense: valueChangeNumberSchema,
        criticalRate: valueChangeNumberSchema,
        actionSpeed: valueChangeNumberSchema,
        affinityBonus: valueChangeNumberSchema,
        criticalDamageBonus: valueChangeNumberSchema,
      },
    },
  },
} as const;

/**
 * `10_API設計.md`「BattleStateDeltaResponse」の`exercise`（R-TEX-02／03）。演習だけで
 * 現れるため、通常戦闘の`battleStateDeltaResponseSchema`へは足さず演習側だけが持つ
 * ——`additionalProperties: false`のまま、どちらのエンドポイントが何を返し得るかを
 * schemaで正確に表す。
 */
const exerciseBattleStateDeltaResponseSchema = {
  ...battleStateDeltaResponseSchema,
  properties: {
    ...battleStateDeltaResponseSchema.properties,
    units: { type: "object", additionalProperties: exerciseUnitStateDeltaResponseSchema },
    exercise: {
      type: "object",
      additionalProperties: false,
      properties: {
        totalScore: valueChangeNumberSchema,
        breakCount: valueChangeNumberSchema,
      },
    },
  },
} as const;

const exerciseStateTransitionResponseSchema = {
  ...stateTransitionResponseSchema,
  properties: {
    ...stateTransitionResponseSchema.properties,
    delta: exerciseBattleStateDeltaResponseSchema,
  },
} as const;

/**
 * `200 OK`成功レスポンスbody schema（`10_API設計.md`「TacticalExerciseResponse」）。
 * `BattleSimulationResponse`と同じ構造を再利用し、`result`だけを演習結果へ差し替える
 * （状態差分だけは演習固有の項目を足した版を使う）。
 */
export const tacticalExerciseResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "battleId",
    "catalogRevision",
    "result",
    "initialState",
    "finalState",
    "unitSummaries",
    "events",
    "stateTransitions",
  ],
  properties: {
    schemaVersion: { type: "integer" },
    battleId: { type: "string" },
    catalogRevision: { type: "string" },
    result: exerciseResultResponseSchema,
    initialState: battleStateResponseSchema,
    finalState: battleStateResponseSchema,
    unitSummaries: { type: "array", items: unitBattleSummaryResponseSchema },
    events: { type: "array", items: battleLogEventResponseSchema },
    stateTransitions: { type: "array", items: exerciseStateTransitionResponseSchema },
  },
} as const;

/**
 * OpenAPI公開専用の`200`成功レスポンスschema。実行時の
 * `tacticalExerciseResponseSchema`と唯一違うのは`events[].details`
 * （イベント種別ごとの構造を文書化する）で、`battleSimulationResponseDocSchema`と
 * 同じ理由による。unionは演習専用variant（`EXERCISE_SCORE_ACCUMULATED`／`UNIT_BROKEN`／
 * `UNIT_REVIVED`と`BREAK_ENHANCEMENT`を取り得る`reason`）を含む版であり、通常戦闘の
 * 公開文書はそれらを持たない（`Q-TEX-08`）。
 */
export const tacticalExerciseResponseDocSchema = {
  ...tacticalExerciseResponseSchema,
  properties: {
    ...tacticalExerciseResponseSchema.properties,
    events: { type: "array", items: exerciseBattleLogEventResponseDocSchema },
  },
} as const;
