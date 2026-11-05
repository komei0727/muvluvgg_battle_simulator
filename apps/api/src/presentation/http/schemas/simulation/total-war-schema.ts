import {
  battleStateDeltaResponseSchema,
  battleStateResponseSchema,
  battleUnitStateResponseSchema,
  formationPositionResponseSchema,
  formationRequestDocSchema,
  formationRequestSchema,
  globalCoordinateResponseSchema,
  simulationOptionsRequestDocSchema,
  simulationOptionsRequestSchema,
  stateTransitionResponseSchema,
  unitBattleSummaryResponseSchema,
  valueChangeNumberSchema,
} from "./simulation-schema.js";
import {
  battleLogEventResponseSchema,
  defeatedFormationCountsResponseSchema,
  totalWarBattleLogEventResponseDocSchema,
  totalWarStageResponseSchema,
} from "../battle-log/battle-log-schema.js";

/**
 * `POST /api/v1/total-war-simulations`のJSON Schema（`10_API設計.md`
 * 「総力戦をシミュレーションする」）。
 *
 * 編成の要素は戦闘シミュレーションのschemaをそのまま再利用する——同じ編成JSONが
 * 片方のエンドポイントでだけ通る状態を作らないため。`turnLimit`は持たず（R-TWR-01 #5）、
 * 未定義のトップレベルプロパティは`additionalProperties: false`が構造違反
 * （`400 MALFORMED_REQUEST`）として拒否する。
 *
 * 編成数の1～3件（R-TWR-01 #1）は実行時schemaでは絞らない。`simulation-schema.ts`冒頭の
 * 注記と同じく、人数・件数の違反はアプリケーション検証の`422 INVALID_COMMAND`が返す
 * ——ここで`minItems`/`maxItems`を持たせると、境界値が`400`と`422`のどちらで拒否されるかが
 * 契約と一致しなくなる。値域は公開文書側（`totalWarRequestDocSchema`）だけが持つ。
 */
export const totalWarRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormations", "enemyFormations"],
  properties: {
    allyFormations: { type: "array", items: formationRequestSchema },
    enemyFormations: { type: "array", items: formationRequestSchema },
    options: simulationOptionsRequestSchema,
  },
} as const;

/** R-TWR-01 #1: 各陣営1～3編成。公開文書専用（実行時validationには使わない）。 */
const formationListRequestDocSchema = {
  type: "array",
  items: formationRequestDocSchema,
  minItems: 1,
  maxItems: 3,
} as const;

export const totalWarRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormations", "enemyFormations"],
  properties: {
    allyFormations: formationListRequestDocSchema,
    enemyFormations: formationListRequestDocSchema,
    options: simulationOptionsRequestDocSchema,
  },
} as const;

const formationNumberSchema = { type: "integer", minimum: 1, maximum: 3 } as const;

/**
 * 総力戦の`BattleUnitStateResponse`。所属する編成の番号を足す。通常戦闘・戦術演習の
 * 共有schemaへは足さず総力戦側だけが持つ——既存エンドポイントの公開契約を変えないため。
 */
const totalWarBattleUnitStateResponseSchema = {
  ...battleUnitStateResponseSchema,
  properties: {
    ...battleUnitStateResponseSchema.properties,
    formationNumber: formationNumberSchema,
  },
} as const;

/** `10_API設計.md`「SideFormationStateResponse」。 */
const sideFormationStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["formationCount", "activeFormationNumber", "defeatedCount"],
  properties: {
    formationCount: formationNumberSchema,
    activeFormationNumber: formationNumberSchema,
    defeatedCount: { type: "integer", minimum: 0, maximum: 3 },
  },
} as const;

const totalWarBattleStateResponseSchema = {
  ...battleStateResponseSchema,
  properties: {
    ...battleStateResponseSchema.properties,
    units: { type: "array", items: totalWarBattleUnitStateResponseSchema },
    formations: {
      type: "object",
      additionalProperties: false,
      required: ["ally", "enemy"],
      properties: {
        ally: sideFormationStateResponseSchema,
        enemy: sideFormationStateResponseSchema,
      },
    },
  },
} as const;

const sideFormationDeltaResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    activeFormationNumber: valueChangeNumberSchema,
    defeatedCount: valueChangeNumberSchema,
  },
} as const;

/**
 * `10_API設計.md`「BattleStateDeltaResponse」の`addedUnits`／`formations`（R-TWR-03／04）。
 * 演習の`exercise`と同じく、総力戦だけで現れるため総力戦側だけが持つ。
 */
const totalWarBattleStateDeltaResponseSchema = {
  ...battleStateDeltaResponseSchema,
  properties: {
    ...battleStateDeltaResponseSchema.properties,
    addedUnits: { type: "array", items: totalWarBattleUnitStateResponseSchema },
    formations: {
      type: "object",
      additionalProperties: false,
      properties: {
        ally: sideFormationDeltaResponseSchema,
        enemy: sideFormationDeltaResponseSchema,
      },
    },
  },
} as const;

const totalWarStateTransitionResponseSchema = {
  ...stateTransitionResponseSchema,
  properties: {
    ...stateTransitionResponseSchema.properties,
    delta: totalWarBattleStateDeltaResponseSchema,
  },
} as const;

/** `10_API設計.md`「UnitBattleSummaryResponse」の総力戦だけが持つ2項目を足した版。 */
const totalWarUnitBattleSummaryResponseSchema = {
  ...unitBattleSummaryResponseSchema,
  required: [...unitBattleSummaryResponseSchema.required, "formationNumber", "deployed"],
  properties: {
    ...unitBattleSummaryResponseSchema.properties,
    formationNumber: formationNumberSchema,
    deployed: { type: "boolean" },
  },
} as const;

/** `10_API設計.md`「TotalWarUnitRosterResponse」。 */
const totalWarUnitRosterResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "battleUnitId",
    "unitDefinitionId",
    "side",
    "formationNumber",
    "formationPosition",
    "coordinate",
    "reappearance",
    "deployed",
  ],
  properties: {
    battleUnitId: { type: "string" },
    unitDefinitionId: { type: "string" },
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    formationNumber: formationNumberSchema,
    formationPosition: formationPositionResponseSchema,
    coordinate: globalCoordinateResponseSchema,
    reappearance: { type: "boolean" },
    deployed: { type: "boolean" },
  },
} as const;

/**
 * `10_API設計.md`「TotalWarResultResponse」。通常戦闘と違い`outcome`は`DRAW`をとり、
 * `SIMULTANEOUS_DEFEAT`は引き分けを表す（R-TWR-06 #1）。
 */
const totalWarResultResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "completionReason", "completedTurn", "stages", "defeatedFormationCounts"],
  properties: {
    outcome: { type: "string", enum: ["ALLY_WIN", "ALLY_LOSE", "DRAW"] },
    completionReason: {
      type: "string",
      enum: ["ENEMY_DEFEATED", "ALLY_DEFEATED", "SIMULTANEOUS_DEFEAT", "TURN_LIMIT_REACHED"],
    },
    // R-TWR-01 #5: 規定ターン数は15固定。
    completedTurn: { type: "integer", minimum: 1, maximum: 15 },
    stages: { type: "array", items: totalWarStageResponseSchema },
    defeatedFormationCounts: defeatedFormationCountsResponseSchema,
  },
} as const;

/**
 * `200 OK`成功レスポンスbody schema（`10_API設計.md`「TotalWarResponse」）。
 * `BattleSimulationResponse`と同じ構造を再利用し、`result`を総力戦の結果へ差し替え、
 * 全編成のユニット一覧`unitRoster`を足す。
 */
export const totalWarResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "battleId",
    "catalogRevision",
    "result",
    "initialState",
    "unitRoster",
    "unitSummaries",
    "events",
    "stateTransitions",
  ],
  properties: {
    schemaVersion: { type: "integer" },
    battleId: { type: "string" },
    catalogRevision: { type: "string" },
    result: totalWarResultResponseSchema,
    initialState: totalWarBattleStateResponseSchema,
    finalState: totalWarBattleStateResponseSchema,
    unitRoster: { type: "array", items: totalWarUnitRosterResponseSchema },
    unitSummaries: { type: "array", items: totalWarUnitBattleSummaryResponseSchema },
    events: { type: "array", items: battleLogEventResponseSchema },
    stateTransitions: { type: "array", items: totalWarStateTransitionResponseSchema },
  },
} as const;

/**
 * OpenAPI公開専用の`200`成功レスポンスschema。実行時schemaとの違いは`events[].details`
 * だけで、総力戦専用variant（`FORMATION_DEFEATED`／`FORMATION_DEPLOYED`と総力戦の
 * `BATTLE_COMPLETED`）を含み演習専用variantを含まないunionを使う。
 */
export const totalWarResponseDocSchema = {
  ...totalWarResponseSchema,
  properties: {
    ...totalWarResponseSchema.properties,
    events: { type: "array", items: totalWarBattleLogEventResponseDocSchema },
  },
} as const;
