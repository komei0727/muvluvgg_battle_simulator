import {
  combatStatsResponseSchema,
  formationPositionResponseSchema,
  formationRequestDocSchema,
  formationRequestSchema,
} from "./simulation-schema.js";

/**
 * 公開文書上の人数の下限だけを0へ緩めた編成schema。プレビューは陣営ごとに独立して
 * 算出でき、片側だけ組みかけの編成にも意味がある（`10_API設計.md`
 * 「FormationStatPreviewRequest」）。上限5件・メモリー0〜6件などの他の値域は
 * 戦闘リクエストの公開schemaをそのまま引き継ぐ。
 */
const previewFormationRequestDocSchema = {
  ...formationRequestDocSchema,
  properties: {
    ...formationRequestDocSchema.properties,
    units: { ...formationRequestDocSchema.properties.units, minItems: 0 },
  },
} as const;

/**
 * `POST /api/v1/formation-stat-previews`のJSON Schema。
 *
 * 編成部分は戦闘シミュレーションのschemaをそのまま再利用する
 * （`10_API設計.md`「編成部分は`BattleSimulationRequest`と同形にする」）——
 * 同じ編成JSONが片方のエンドポイントでだけ通る状態を作らないため。人数の下限
 * だけは公開文書側で0へ緩める（上の`previewFormationRequestDocSchema`参照）。
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
    // R-TEX-11 #5: 編成プール検証に使う戦闘モード。列挙値の検証は公開文書側と
    // アプリケーション検証が持つ（simulation-schema.ts冒頭の注記と同じ分担）。
    mode: { type: "string" },
  },
} as const;

export const formationStatPreviewRequestDocSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allyFormation", "enemyFormation"],
  properties: {
    allyFormation: previewFormationRequestDocSchema,
    enemyFormation: previewFormationRequestDocSchema,
    mode: { type: "string", enum: ["NORMAL", "TACTICAL_EXERCISE"] },
  },
} as const;

/**
 * `10_API設計.md`「FormationStatPreviewUnitResponse」: R-ENH-06の強化後基本
 * ステータス（編成補正・適性補正の適用前）。比率3項目の単位は`CombatStatsResponse`と
 * 同じパーセントポイントであり、`maximumHp`だけを補って同形にする。
 */
const formationStatPreviewBaseStatsResponseSchema = {
  ...combatStatsResponseSchema,
  required: [...combatStatsResponseSchema.required, "maximumHp"],
  properties: {
    ...combatStatsResponseSchema.properties,
    // R-NUM-01: 補正後の`maximumHp`と同じく丸めない全精度値。
    maximumHp: { type: "number", minimum: 0 },
  },
} as const;

/** `10_API設計.md`「FormationStatPreviewUnitResponse」。 */
const formationStatPreviewUnitResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "side",
    "unitDefinitionId",
    "formationPosition",
    "maximumHp",
    "combatStats",
    "enhancedBaseStats",
  ],
  properties: {
    side: { type: "string", enum: ["ALLY", "ENEMY"] },
    unitDefinitionId: { type: "string" },
    formationPosition: formationPositionResponseSchema,
    // R-NUM-01: `BattleUnitStateResponse.hp.maximum`と同じく丸めない全精度値。
    maximumHp: { type: "number", minimum: 0 },
    combatStats: combatStatsResponseSchema,
    enhancedBaseStats: formationStatPreviewBaseStatsResponseSchema,
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
