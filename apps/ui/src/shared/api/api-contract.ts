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
import type { paths } from "./generated/v1.js";
import type { GearInput, LogLevel, UiColumn, UiRow } from "../../entities/battle-draft.js";

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

// docs/ddd/10_API設計.md「CatalogSkillSummaryResponse」「CatalogEffectSummaryResponse」。
// 戦闘ログの定義IDを表示名へ読み替えるための要約。
export type CatalogSkillSummary = GeneratedCatalogResponse["skills"][number];
export type CatalogEffectSummary = GeneratedCatalogResponse["effects"][number];

export type CatalogUnitSummary = Omit<
  GeneratedCatalogUnitSummary,
  "category" | "exerciseActive"
> & {
  /**
   * R-TEX-11 #1: 編成プールの区分（`PLAYABLE`／`EXERCISE_ENEMY`）。`gearEffects`と
   * 同じく、この項目を返さない旧APIと組み合わせても壊さないため任意項目にする
   * （生成型は必須項目として文書化しているが、それより前にデプロイされたAPIとの
   * 組み合わせを許すためUI側で緩めている）。不在は`PLAYABLE`として扱う。
   */
  readonly category?: string;
  /**
   * R-TEX-11 #4: 開催中バッジ用の表示専用情報。`EXERCISE_ENEMY`のときだけ届く。
   * 生成型も現状は任意項目だが、`category`と同じ理由でUI側にも明示しておく
   * ——生成型がOpenAPI側の変更で必須化されても、この項目を返さない旧APIの
   * 応答をUIが受け入れ続けられるようにするため（暗黙の一致に依存しない）。
   */
  readonly exerciseActive?: boolean;
};

export type CatalogMemorySummary = GeneratedCatalogResponse["memories"][number];

// docs/ddd/10_API設計.md「CatalogGearEffectResponse」(R-ENH-04 #3 の効果表)。
// `percentagePoints` はパーセントポイントのまま届く（内部表現の小数ではない）。
export type CatalogGearEffectValue = GeneratedCatalogGearEffect["values"][number];
export type CatalogGearEffect = GeneratedCatalogGearEffect;

export interface BattleSimulationCatalogResponse extends Omit<
  GeneratedCatalogResponse,
  "units" | "gearEffects" | "skills" | "effects"
> {
  readonly units: readonly CatalogUnitSummary[];
  /** 効果表を公開しない旧APIと組み合わせても壊さないため任意項目にする（生成型は必須）。 */
  readonly gearEffects?: readonly CatalogGearEffect[];
  /** `gearEffects`と同じ理由で任意項目にする（生成型は必須）。不在時は定義IDで表示する。 */
  readonly skills?: readonly CatalogSkillSummary[];
  /** `gearEffects`と同じ理由で任意項目にする（生成型は必須）。不在時は定義IDで表示する。 */
  readonly effects?: readonly CatalogEffectSummary[];
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
  | "RESPONSE_CONTRACT_MISMATCH"
  | "UNAUTHORIZED";

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

// docs/ddd/10_API設計.md「TotalWarResponse」/ docs/ui-design/03_API・データ連携設計.md §2.7, §9.2。
// 戦闘ログ部分は`BattleLogResponse`と同じく手書きの緩いmirrorにする（未知の列挙値・
// 追加プロパティを落とさない）。生成型との整合は、生成型がこのmirrorへ代入できることを
// `response-validator.total-war.test.ts`の型検査で固定する。

/** 総力戦の`BattleUnitStateResponse`。所属する編成の番号を持つ。 */
export interface TotalWarBattleUnitStateResponse extends BattleUnitStateResponse {
  readonly formationNumber?: number;
}

/** docs/ddd/10_API設計.md「SideFormationStateResponse」。 */
export interface SideFormationStateResponse {
  readonly formationCount: number;
  readonly activeFormationNumber: number;
  readonly defeatedCount: number;
  readonly [key: string]: unknown;
}

export interface TotalWarBattleStateResponse extends BattleStateResponse {
  readonly units: readonly TotalWarBattleUnitStateResponse[];
  readonly formations?: {
    readonly ally: SideFormationStateResponse;
    readonly enemy: SideFormationStateResponse;
  };
}

/**
 * docs/ddd/10_API設計.md「BattleStateDeltaResponse」の総力戦だけが持つ2項目。
 * `addedUnits`は`FORMATION_DEPLOYED`で盤面へ加わったユニットの完全な開始状態、
 * `formations`は陣営ごとの表示中編成・撃破数の値の変化。
 */
export interface TotalWarStateDeltaResponse {
  readonly addedUnits?: readonly TotalWarBattleUnitStateResponse[];
  readonly formations?: {
    readonly ally?: Readonly<Record<string, unknown>>;
    readonly enemy?: Readonly<Record<string, unknown>>;
  };
  readonly [key: string]: unknown;
}

export interface TotalWarStateTransitionResponse extends StateTransitionResponse {
  readonly delta?: TotalWarStateDeltaResponse;
}

/** docs/ddd/10_API設計.md「TotalWarStageResponse」（R-TWR-06 #4）。 */
export interface TotalWarStageResponse {
  readonly stageNumber: number;
  readonly allyFormationNumber: number;
  readonly enemyFormationNumber: number;
  readonly startTurn: number;
  readonly endTurn: number;
  readonly defeatedSides: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * docs/ddd/10_API設計.md「TotalWarResultResponse」。通常戦闘と違い`outcome`は`DRAW`をとり、
 * `completionReason`の`SIMULTANEOUS_DEFEAT`・`TURN_LIMIT_REACHED`は引き分けを表す（R-TWR-06 #1）。
 */
export interface TotalWarResultResponse {
  readonly outcome: string;
  readonly completionReason: string;
  readonly completedTurn: number;
  readonly stages: readonly TotalWarStageResponse[];
  readonly defeatedFormationCounts: { readonly ally: number; readonly enemy: number };
  readonly [key: string]: unknown;
}

/** docs/ddd/10_API設計.md「TotalWarUnitRosterResponse」。全編成の全ユニットを1行ずつ持つ。 */
export interface TotalWarUnitRosterResponse {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly formationNumber: number;
  readonly formationPosition: {
    readonly column: number;
    readonly row: string;
    readonly [key: string]: unknown;
  };
  /** 再登場の基礎値補正（R-TWR-02）を受けたか。UIは表示にだけ使う。 */
  readonly reappearance: boolean;
  /** 一度でも盤面へ出たか。控えのまま終わった編成のユニットは`false`。 */
  readonly deployed: boolean;
  readonly [key: string]: unknown;
}

/** 総力戦の`UnitBattleSummaryResponse`。出撃しなかったユニットの行も持つ。 */
export interface TotalWarUnitBattleSummaryResponse extends UnitBattleSummaryResponse {
  readonly formationNumber: number;
  readonly deployed: boolean;
}

/**
 * docs/ddd/10_API設計.md「TotalWarResponse」。`initialState`は両陣営の1番目の編成だけを
 * 含むため、表示用Rosterは`unitRoster`から作る（03_API・データ連携設計.md §10.1）。
 */
export interface TotalWarResponse extends BattleLogResponse {
  readonly result: TotalWarResultResponse;
  readonly initialState: TotalWarBattleStateResponse;
  readonly finalState?: TotalWarBattleStateResponse;
  readonly unitRoster: readonly TotalWarUnitRosterResponse[];
  readonly unitSummaries: readonly TotalWarUnitBattleSummaryResponse[];
  readonly stateTransitions: readonly TotalWarStateTransitionResponse[];
}

export type TotalWarApiResult = ExecutionApiResult<TotalWarResponse>;

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

// Mirrors docs/ui-design/03_API・データ連携設計.md §4-5 (request generation
// rules). リクエスト本文の型。組み立て（`features/formation/request-mapper.ts`
// `features/exercise/exercise-request-mapper.ts`）は編成機能固有のロジックとして
// featureに残るが、送信本文の形そのものは`shared/api/api-client.ts`が直接送る
// wire型であり、レスポンス型と同じくここが正本（REF-055）。

/** docs/ddd/10_API設計.md「ModuleStatOverrideRequest」(R-ENH-08). */
export interface ModuleStatOverrideRequest {
  readonly fixed?: number;
  readonly ratio?: number;
}

/** docs/ddd/10_API設計.md「ModuleOverrideRequest」(R-ENH-08). */
export interface ModuleOverrideRequest {
  readonly hp?: ModuleStatOverrideRequest;
  readonly attack?: ModuleStatOverrideRequest;
  readonly defense?: ModuleStatOverrideRequest;
}

/** docs/ui-design/03_API・データ連携設計.md §5.1 (M11)。`module`はR-ENH-08で追加。 */
export interface UnitEnhancementRequest {
  readonly level: number;
  readonly rank: number;
  readonly gears: readonly GearInput[];
  readonly module?: ModuleOverrideRequest;
}

export interface FormationEnhancementRequest {
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<string, number>>;
    readonly attributes: Readonly<Record<string, number>>;
  };
}

export interface BattleSimulationUnitRequest {
  readonly unitDefinitionId: string;
  readonly position: { readonly column: UiColumn; readonly row: UiRow };
  readonly enhancement?: UnitEnhancementRequest;
}

export interface FormationRequest {
  readonly units: readonly BattleSimulationUnitRequest[];
  readonly memoryDefinitionIds: readonly string[];
  readonly enhancement?: FormationEnhancementRequest;
}

export interface BattleSimulationRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly turnLimit: number;
  readonly options: { readonly logLevel: LogLevel };
}

/** `10_API設計.md`「FormationStatPreviewRequest」の`mode`。省略時は`NORMAL`。 */
export type FormationStatPreviewMode = "NORMAL" | "TACTICAL_EXERCISE";

/** docs/ui-design/03_API・データ連携設計.md §2.5: プレビューは編成部分だけを送る。 */
export interface FormationStatPreviewRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  /** R-TEX-11 #5: 編成プール検証にだけ使う。ステータス計算へは影響しない。 */
  readonly mode?: FormationStatPreviewMode;
}

// docs/ddd/10_API設計.md「TacticalExerciseRequest」: 編成部分は戦闘シミュレーションと
// 同じ`FormationRequest`を再利用し、`turnLimit`を持たない。
export interface TacticalExerciseRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly options: { readonly logLevel: LogLevel };
}

/**
 * docs/ddd/10_API設計.md「TotalWarRequest」/ 03_API・データ連携設計.md §5.2。各陣営の編成を
 * 出撃順に1〜3件並べる。`turnLimit`は持たない（15固定。APIは未定義プロパティとして拒否する）。
 */
export interface TotalWarRequest {
  readonly allyFormations: readonly FormationRequest[];
  readonly enemyFormations: readonly FormationRequest[];
  readonly options: { readonly logLevel: LogLevel };
}

/**
 * `10_API設計.md`「TacticalExerciseEvaluationRequest」。統計実行の1チャンク分の本文。
 * `options`（`logLevel`）を持たない —— 返るのは試行ごとの数値だけで、イベント列も
 * 状態遷移も返らないため、公開レベルという概念自体が無い。
 */
export interface TacticalExerciseEvaluationRequest {
  readonly enemyFormation: FormationRequest;
  readonly candidates: readonly { readonly allyFormation: FormationRequest }[];
  readonly runsPerCandidate: number;
  /**
   * 送信seed。省略するとサーバーが生成する（Q-TEX-17）が、統計実行はチャンクごとに
   * `#<runOffset>`を付けた別seedを送る必要があるため常に指定する。
   */
  readonly seed: string;
}
