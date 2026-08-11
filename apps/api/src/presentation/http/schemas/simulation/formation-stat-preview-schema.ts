import {
  combatStatsResponseSchema,
  formationPositionResponseSchema,
  formationRequestDocSchema,
  formationRequestSchema,
} from "./simulation-schema.js";

/**
 * `POST /api/v1/formation-stat-previews`のJSON Schema。
 *
 * 編成部分は戦闘シミュレーションのschemaをそのまま再利用する
 * （`10_API設計.md`「編成部分は`BattleSimulationRequest`と同形にする」）——
 * 同じ編成JSONが片方のエンドポイントでだけ通る状態を作らないため。
 * 実行時schemaが値域・列挙値を持たず公開文書側だけが持つ理由は
 * `simulation-schema.ts`冒頭の注記と同じ。
 */
export const formationStatPreviewRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation"],
  properties: {
    allyFormation: formationRequestSchema,
    enemyFormation: formationRequestSchema,
  },
} as const;

export const formationStatPreviewRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation"],
  properties: {
    allyFormation: formationRequestDocSchema,
    enemyFormation: formationRequestDocSchema,
  },
} as const;

/** `10_API設計.md`「FormationStatPreviewUnitResponse」。 */
const formationStatPreviewUnitResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["side", "unitDefinitionId", "formationPosition", "maximumHp", "combatStats"],
  properties: {
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    unitDefinitionId: { type: "string" },
    formationPosition: formationPositionResponseSchema,
    // R-NUM-01: `BattleUnitStateResponse.hp.maximum`と同じく丸めない全精度値。
    maximumHp: { type: "number", minimum: 0 },
    combatStats: combatStatsResponseSchema,
  },
} as const;

export const formationStatPreviewResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "units"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string" },
    units: { type: "array", items: formationStatPreviewUnitResponseSchema },
  },
} as const;
