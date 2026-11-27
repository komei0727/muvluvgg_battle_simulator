/**
 * `10_API設計.md`の外部JSON契約と同じ形の、ブランド型を含まないプレーンな型群。
 * Presentation層（Fastify JSON Schema・ルートハンドラ）はこのファイルだけを
 * importすればよく、domain層のbranded typeへ直接触れずに済む
 * （`no-restricted-imports`によるpresentation→domain遮断を維持するため）。
 *
 * ここに定義する型はワイヤーフォーマットの正本であり、値の生成ロジックは
 * 持たない。DTO→Commandの変換は`simulate-battle-request-mapper.ts`が担う。
 *
 * `POST /api/v1/battle-simulations`のrequest body契約型を持つ。
 */

export interface FormationPositionRequestBody {
  readonly column: number;
  readonly row: string;
}

/** `10_API設計.md`「GearRequest」。列挙値の検証は`validateCommandShape`（422）が行う。 */
export interface GearRequestBody {
  readonly stat: string;
  readonly tier: string;
  readonly grade: string;
}

/** `10_API設計.md`「ModuleStatOverrideRequest」（R-ENH-08）。 */
export interface ModuleStatOverrideRequestBody {
  readonly fixed?: number;
  readonly ratio?: number;
}

/** `10_API設計.md`「ModuleOverrideRequest」（R-ENH-08）。 */
export interface ModuleOverrideRequestBody {
  readonly hp?: ModuleStatOverrideRequestBody;
  readonly attack?: ModuleStatOverrideRequestBody;
  readonly defense?: ModuleStatOverrideRequestBody;
}

/** `10_API設計.md`「UnitEnhancementRequest」（M11、R-ENH-08で`module`を追加）。 */
export interface UnitEnhancementRequestBody {
  readonly level?: number;
  readonly rank?: number;
  readonly gears?: readonly GearRequestBody[];
  readonly module?: ModuleOverrideRequestBody;
}

/**
 * `10_API設計.md`「AcademyLevelsRequest」（M11）。省略したキーはレベル1として扱う
 * （R-ENH-02 #1）。キー集合はJSON Schemaが固定するため、ここでは任意の数値マップとする。
 */
export interface AcademyLevelsRequestBody {
  readonly unitTypes?: Readonly<Record<string, number>>;
  readonly attributes?: Readonly<Record<string, number>>;
}

/** `10_API設計.md`「FormationEnhancementRequest」（M11）。 */
export interface FormationEnhancementRequestBody {
  readonly academyLevels?: AcademyLevelsRequestBody;
}

export interface FormationUnitRequestBody {
  readonly unitDefinitionId: string;
  readonly position: FormationPositionRequestBody;
  readonly enhancement?: UnitEnhancementRequestBody;
}

export interface FormationRequestBody {
  readonly units: readonly FormationUnitRequestBody[];
  readonly memoryDefinitionIds: readonly string[];
  readonly enhancement?: FormationEnhancementRequestBody;
}

export interface SimulationOptionsRequestBody {
  readonly logLevel?: string;
}

/**
 * `10_API設計.md`「SimulationReplay」。大量試行の1試行を単発APIで再実行する指定で、
 * 3形式の単発APIが同じ形で受け取る。値域・照合は`validateSimulationReplay`（422）が行う。
 */
export interface SimulationReplayRequestBody {
  readonly seed: string;
  readonly runIndex: number;
  readonly expectedCatalogRevision: string;
  readonly expectedEngineRevision: string;
  readonly expectedSeedDerivationVersion: string;
}

export interface BattleSimulationRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly turnLimit: number;
  readonly options?: SimulationOptionsRequestBody;
  readonly replay?: SimulationReplayRequestBody;
}

/**
 * `10_API設計.md`「戦術演習をシミュレーションする」（`POST /api/v1/tactical-exercises`）の
 * request body契約。編成部分は戦闘リクエストと同形で、`turnLimit`を持たない —
 * 規定ターン数は5固定であり、リクエストで指定できない（R-TEX-01 #4）。
 */
export interface TacticalExerciseRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly options?: SimulationOptionsRequestBody;
  readonly replay?: SimulationReplayRequestBody;
}

/**
 * `10_API設計.md`「TotalWarRequest」（`POST /api/v1/total-war-simulations`）の request body契約。
 * 各陣営の編成を出撃順に1～3件持ち、`turnLimit`を持たない — 規定ターン数は15固定であり、
 * リクエストで指定できない（R-TWR-01 #5）。
 */
export interface TotalWarRequestBody {
  readonly allyFormations: readonly FormationRequestBody[];
  readonly enemyFormations: readonly FormationRequestBody[];
  readonly options?: SimulationOptionsRequestBody;
  readonly replay?: SimulationReplayRequestBody;
}

/**
 * `10_API設計.md`「FormationStatPreviewRequest」。編成部分は戦闘リクエストと
 * 同形にし、`turnLimit`・`options`を持たない（戦闘を実行しないため、どちらも
 * 開始時ステータスへ影響しない）。
 */
export interface FormationStatPreviewRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  /** R-TEX-11 #5: 編成プール検証に使う戦闘モード。省略時は`NORMAL`。 */
  readonly mode?: "NORMAL" | "TACTICAL_EXERCISE";
}

/**
 * `10_API設計.md`「TacticalExerciseEvaluationCaseRequest」。両陣営をケースごとに持つ。
 * 規定ターン数は演習で固定（R-TEX-01 #4）のため`turnLimit`を持たない。
 */
export interface TacticalExerciseEvaluationCaseRequestBody {
  readonly caseId: string;
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly runIndices: readonly number[];
}

/**
 * `10_API設計.md`「戦術演習を大量試行する」（`POST /api/v1/tactical-exercise-evaluations`）の
 * request body契約。通常戦闘・総力戦の大量試行と同じトップレベル構造を持ち、`seed`は必須で
 * サーバーは暗黙に生成しない。`options.logLevel`を持たない。
 */
export interface TacticalExerciseEvaluationRequestBody {
  readonly seed: string;
  readonly cases: readonly TacticalExerciseEvaluationCaseRequestBody[];
  readonly expectedCatalogRevision?: string;
  readonly expectedEngineRevision?: string;
}

/** `10_API設計.md`「BattleEvaluationCaseRequest」。両陣営と規定ターン数をケースごとに持つ。 */
export interface BattleEvaluationCaseRequestBody {
  readonly caseId: string;
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly turnLimit: number;
  readonly runIndices: readonly number[];
}

/**
 * `10_API設計.md`「通常戦闘を大量試行する」（`POST /api/v1/battle-evaluations`）の request body契約。
 * `seed`は必須で、サーバーは暗黙に生成しない。`options.logLevel`を持たない。
 */
export interface BattleEvaluationRequestBody {
  readonly seed: string;
  readonly cases: readonly BattleEvaluationCaseRequestBody[];
  readonly expectedCatalogRevision?: string;
  readonly expectedEngineRevision?: string;
}

/** `10_API設計.md`「TotalWarEvaluationCaseRequest」。各陣営の編成を出撃順に持ち、`turnLimit`を持たない。 */
export interface TotalWarEvaluationCaseRequestBody {
  readonly caseId: string;
  readonly allyFormations: readonly FormationRequestBody[];
  readonly enemyFormations: readonly FormationRequestBody[];
  readonly runIndices: readonly number[];
}

/** `10_API設計.md`「総力戦を大量試行する」（`POST /api/v1/total-war-evaluations`）の request body契約。 */
export interface TotalWarEvaluationRequestBody {
  readonly seed: string;
  readonly cases: readonly TotalWarEvaluationCaseRequestBody[];
  readonly expectedCatalogRevision?: string;
  readonly expectedEngineRevision?: string;
}
