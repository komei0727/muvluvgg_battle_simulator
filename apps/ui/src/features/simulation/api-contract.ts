// Mirrors docs/ddd/10_API設計.md and docs/ui-design/03_API・データ連携設計.md §2, §7, §8, §13.
//
// REF-052 (Issue #597): the Catalog / FormationStatPreview / TacticalExerciseEvaluation wire
// types below are derived from `shared/api/generated/v1.d.ts`, which
// `scripts/generate-openapi-types.mjs` regenerates from `apps/api/openapi/v1-baseline.json`
// (drift is caught by `scripts/check-openapi-types.mjs` / `mise run ui:openapi:check`). This
// replaces the hand-written mirror those three previously had, so API additions can no longer
// go silently unnoticed by the UI's types (02_フロントエンドアーキテクチャ設計.md §8).
//
// The battle-simulation / tactical-exercise event-log family below (`BattleLogResponse` and
// everything it composes) stays hand-written and deliberately looser than the generated shape:
// only what `response-validator.ts` actually checks is narrowed, and unknown nested properties
// are preserved via index signatures. That predates this Issue and is out of its scope — see
// the PR/Issue discussion for the full list of generated-vs-mirror differences this Issue found.
import type { paths } from "../../shared/api/generated/v1.js";

/** Recursively applies `readonly`, matching the immutability this file has always exposed. */
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// docs/ddd/10_API設計.md「BattleSimulationCatalogResponse」.
type GeneratedCatalogResponse = DeepReadonly<
  paths["/api/v1/battle-simulation-catalog"]["get"]["responses"][200]["content"]["application/json"]
>;
type GeneratedCatalogUnitSummary = GeneratedCatalogResponse["units"][number];
type GeneratedCatalogGearEffect = GeneratedCatalogResponse["gearEffects"][number];

export type CatalogUnitSummary = Omit<GeneratedCatalogUnitSummary, "category"> & {
  /**
   * R-TEX-11 #1: 編成プールの区分（`PLAYABLE`／`EXERCISE_ENEMY`）。`gearEffects`と
   * 同じく、この項目を返さない旧APIと組み合わせても壊さないため任意項目にする
   * （生成型は必須項目として文書化しているが、それより前にデプロイされたAPIとの
   * 組み合わせを許すためUI側で緩めている）。不在は`PLAYABLE`として扱う。
   */
  readonly category?: string;
};

export type CatalogMemorySummary = GeneratedCatalogResponse["memories"][number];

// docs/ddd/10_API設計.md「CatalogGearEffectResponse」(R-ENH-04 #3 の効果表)。
// `percentagePoints` はパーセントポイントのまま届く（内部表現の小数ではない）。
export type CatalogGearEffectValue = GeneratedCatalogGearEffect["values"][number];
export type CatalogGearEffect = GeneratedCatalogGearEffect;

export interface BattleSimulationCatalogResponse extends Omit<
  GeneratedCatalogResponse,
  "units" | "gearEffects"
> {
  readonly units: readonly CatalogUnitSummary[];
  /** 効果表を公開しない旧APIと組み合わせても壊さないため任意項目にする（生成型は必須）。 */
  readonly gearEffects?: readonly CatalogGearEffect[];
}

export interface ViolationResponseBody {
  readonly path?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  readonly message: string;
}

export interface ErrorResponseBody {
  readonly schemaVersion: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly violations: readonly ViolationResponseBody[];
    readonly diagnosticId?: string;
  };
}

export type UiApiErrorKind =
  | "VALIDATION"
  | "RATE_LIMIT"
  | "CAPACITY"
  | "TIMEOUT"
  | "CANCELLED"
  | "SERVER"
  | "NETWORK"
  | "CORS_OR_NETWORK"
  | "RESPONSE_CONTRACT_MISMATCH";

export interface UiApiError {
  readonly kind: UiApiErrorKind;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  readonly diagnosticId?: string;
  readonly violations?: readonly ViolationResponseBody[];
  readonly retryAfterSeconds?: number;
}

export type CatalogApiResult =
  | {
      readonly ok: true;
      readonly response: BattleSimulationCatalogResponse;
      readonly etag?: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: true;
      readonly notModified: true;
      readonly etag: string;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
    };

// Mirrors docs/ddd/10_API設計.md 「成功レスポンス」/「戦闘状態」. Only the
// shape response-validator.ts checks (per 03_API・データ連携設計.md §9) is
// narrowed; unknown nested properties are preserved via index signatures so a
// future field addition on the server doesn't get stripped by this mirror.
export interface BattleResultResponse {
  readonly outcome: string;
  readonly completionReason: string;
  readonly completedTurn: number;
  readonly [key: string]: unknown;
}

export interface BattleUnitStateResponse {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly combatStatus: string;
  readonly hp: {
    readonly current: number;
    readonly maximum: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface BattleStateResponse {
  readonly units: readonly BattleUnitStateResponse[];
  readonly [key: string]: unknown;
}

export interface BattleLogEventResponse {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface StateTransitionResponse {
  readonly [key: string]: unknown;
}

// docs/ddd/10_API設計.md「UnitBattleSummaryResponse」。ユニット別集計はサーバーが
// 確定させ、公開レベルに依存せず必ず届く。UIはイベントを畳み込まずこれを表示する
// ——`SUMMARY`ではダメージ・回復イベント自体が公開されないため、クライアント集計は
// レベルを下げた瞬間に警告なく0になる。
export interface UnitBattleSummaryResponse {
  readonly battleUnitId: string;
  readonly side: string;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly finalHp: number;
  readonly maximumHp: number;
  readonly combatStatus: string;
  readonly [key: string]: unknown;
}

// docs/ddd/10_API設計.md「TacticalExerciseResponse」: 演習は`result`だけを差し替え、
// 残りは戦闘シミュレーションと同じ構造を共有する。ロスター・イベント・状態遷移を
// 読む側（summary projector、詳細表示）は`result`を見ないため、この共通部分だけを
// 要求する型で受け取り、両モードの成功レスポンスをそのまま渡せるようにする。
export interface BattleLogResponse {
  readonly schemaVersion: number;
  readonly battleId: string;
  readonly catalogRevision: string;
  readonly initialState: BattleStateResponse;
  /**
   * サーバーが`SUMMARY`実行で省略しうるため任意にする(ログ方針刷新3/3)。表示に
   * 必要な最終HP・戦闘状態は`unitSummaries`が運ぶので、不在でもサマリー表示は
   * 成立する。`finalState`を読むのは詳細タブ（`DETAILED`実行時のみ表示）だけ。
   */
  readonly finalState?: BattleStateResponse;
  readonly unitSummaries: readonly UnitBattleSummaryResponse[];
  readonly events: readonly BattleLogEventResponse[];
  readonly stateTransitions: readonly StateTransitionResponse[];
}

export interface BattleSimulationResponse extends BattleLogResponse {
  readonly result: BattleResultResponse;
}

// docs/ddd/10_API設計.md「ExerciseBreakResponse」/「ExerciseResultResponse」。
// 勝敗（`outcome`）は含まない。
export interface ExerciseBreakResponse {
  readonly breakNumber: number;
  readonly turnNumber: number;
  readonly cumulativeScoreAtBreak: number;
  /**
   * R-TEX-03 #2のブレイク発生源ユニット定義ID。メモリー由来のブレイクは発生源
   * ユニットを持たない（`R-MEM-04`）ため必須にしない。この項目より前にデプロイ
   * されたAPIとも組み合わせられる。
   */
  readonly sourceUnitDefinitionId?: string;
  readonly [key: string]: unknown;
}

export interface ExerciseResultResponse {
  readonly completionReason: string;
  readonly completedTurn: number;
  readonly totalScore: number;
  readonly breakCount: number;
  readonly breaks: readonly ExerciseBreakResponse[];
  readonly [key: string]: unknown;
}

export interface TacticalExerciseResponse extends BattleLogResponse {
  readonly result: ExerciseResultResponse;
}

/** 戦闘POSTと演習POSTは結果DTOだけが異なり、失敗側の正規化は完全に共通である。 */
export type ExecutionApiResult<TResponse> =
  | {
      readonly ok: true;
      readonly response: TResponse;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
      readonly retryAfterSeconds?: number;
    };

export type SimulationApiResult = ExecutionApiResult<BattleSimulationResponse>;

export type TacticalExerciseApiResult = ExecutionApiResult<TacticalExerciseResponse>;

// docs/ddd/10_API設計.md「TacticalExerciseCandidateEvaluationResponse」。統計量は
// 返らない（Q-TEX-16）ため、UIは試行ごとの生値だけを受け取って自分で集計する。
// 6つの配列は同じ試行を同じ添字で指し、外側の長さは`completedRuns`に一致する。
// `allyUnit*`の内側はリクエストの`candidates[i].allyFormation.units`と同じ長さ・同じ順。
type GeneratedEvaluationResponse = DeepReadonly<
  paths["/api/v1/tactical-exercise-evaluations"]["post"]["responses"][200]["content"]["application/json"]
>;

export type TacticalExerciseCandidateEvaluationResponse =
  GeneratedEvaluationResponse["candidates"][number];

// docs/ddd/10_API設計.md「TacticalExerciseEvaluationResponse」。
export type TacticalExerciseEvaluationResponse = GeneratedEvaluationResponse;

export type TacticalExerciseEvaluationApiResult =
  ExecutionApiResult<TacticalExerciseEvaluationResponse>;

// docs/ddd/10_API設計.md「FormationStatPreviewResponse」/
// docs/ui-design/03_API・データ連携設計.md §2.5, §9.1.
type GeneratedPreviewResponse = DeepReadonly<
  paths["/api/v1/formation-stat-previews"]["post"]["responses"][200]["content"]["application/json"]
>;
type GeneratedPreviewUnit = GeneratedPreviewResponse["units"][number];

export type FormationStatPreviewCombatStats = GeneratedPreviewUnit["combatStats"];

/**
 * R-ENH-06の強化後基本ステータス。編成ボーナス・配置適性補正を適用する**前**の値で、
 * `combatStats`と同じ単位（割合3項目はパーセントポイント）に最大HPを加えた形。
 */
export type FormationStatPreviewBaseStats = GeneratedPreviewUnit["enhancedBaseStats"];

export type FormationStatPreviewUnit = Omit<GeneratedPreviewUnit, "enhancedBaseStats"> & {
  /**
   * 補正前ステータス。**optional** —— APIとUIは別々にデプロイされ、本フィールドを
   * 持たないサーバーの応答も届き得る（10_API設計.md「ローリングデプロイ中の可用性」。
   * 生成型は必須項目として文書化しているが、それより前にデプロイされたAPIとの
   * 組み合わせを許すためUI側で緩めている）。
   */
  readonly enhancedBaseStats?: FormationStatPreviewBaseStats;
};

export interface FormationStatPreviewResponse extends Omit<GeneratedPreviewResponse, "units"> {
  readonly units: readonly FormationStatPreviewUnit[];
}

export type FormationStatPreviewApiResult =
  | {
      readonly ok: true;
      readonly response: FormationStatPreviewResponse;
      readonly requestId?: string;
    }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly error: UiApiError;
      readonly requestId?: string;
    };
