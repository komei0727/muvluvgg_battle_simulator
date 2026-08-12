// Mirrors docs/ddd/10_API設計.md and docs/ui-design/03_API・データ連携設計.md §2, §7, §8, §13.
// The UI keeps its own type mirror rather than importing apps/api types: HTTP wire
// contracts are the source of truth, not the server's internal TypeScript types.

export interface CatalogUnitSummary {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
}

export interface CatalogMemorySummary {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
}

// docs/ddd/10_API設計.md「CatalogGearEffectResponse」(R-ENH-04 #3 の効果表)。
// `percentagePoints` はパーセントポイントのまま届く（内部表現の小数ではない）。
export interface CatalogGearEffectValue {
  readonly tier: string;
  readonly grade: string;
  readonly percentagePoints: number;
}

export interface CatalogGearEffect {
  readonly stat: string;
  /** R-ENH-06: `RATIO` は基本値への割合補正、`POINT` は値そのものへの加算。 */
  readonly application: string;
  readonly values: readonly CatalogGearEffectValue[];
}

export interface BattleSimulationCatalogResponse {
  readonly schemaVersion: 1;
  readonly catalogRevision: string;
  readonly units: readonly CatalogUnitSummary[];
  readonly memories: readonly CatalogMemorySummary[];
  /** 効果表を公開しない旧APIと組み合わせても壊さないため任意項目にする。 */
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

// docs/ddd/10_API設計.md「TacticalExerciseResponse」: 演習は`result`だけを差し替え、
// 残りは戦闘シミュレーションと同じ構造を共有する。ロスター・イベント・状態遷移を
// 読む側（summary projector、詳細表示）は`result`を見ないため、この共通部分だけを
// 要求する型で受け取り、両モードの成功レスポンスをそのまま渡せるようにする。
export interface BattleLogResponse {
  readonly schemaVersion: number;
  readonly battleId: string;
  readonly catalogRevision: string;
  readonly initialState: BattleStateResponse;
  readonly finalState: BattleStateResponse;
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

// docs/ddd/10_API設計.md「FormationStatPreviewResponse」/
// docs/ui-design/03_API・データ連携設計.md §2.5, §9.1.
export interface FormationStatPreviewCombatStats {
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly actionSpeed: number;
  readonly affinityBonus: number;
  readonly criticalDamageBonus: number;
}

export interface FormationStatPreviewUnit {
  readonly side: string;
  readonly unitDefinitionId: string;
  readonly formationPosition: { readonly column: number; readonly row: string };
  /** 戦闘の`initialState.units[].hp.maximum`と同じ、丸めていない最大HP。 */
  readonly maximumHp: number;
  readonly combatStats: FormationStatPreviewCombatStats;
  readonly [key: string]: unknown;
}

export interface FormationStatPreviewResponse {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
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
