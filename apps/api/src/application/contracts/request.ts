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

/** `10_API設計.md`「UnitEnhancementRequest」（M11）。 */
export interface UnitEnhancementRequestBody {
  readonly level?: number;
  readonly gears?: readonly GearRequestBody[];
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

export interface BattleSimulationRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly turnLimit: number;
  readonly options?: SimulationOptionsRequestBody;
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

/** `10_API設計.md`「TacticalExerciseCandidateRequest」。評価対象の味方編成1件。 */
export interface TacticalExerciseCandidateRequestBody {
  readonly allyFormation: FormationRequestBody;
}

/**
 * `10_API設計.md`「戦術演習の編成候補を一括評価する」（`POST /api/v1/tactical-exercise-evaluations`）の
 * request body契約。敵編成はリクエスト全体で1つを共有し、味方編成だけを候補として複数受け取る。
 * `options.logLevel`を持たない——返すのは試行ごとの数値だけで、イベント列は返さないためである。
 */
export interface TacticalExerciseEvaluationRequestBody {
  readonly enemyFormation: FormationRequestBody;
  readonly candidates: readonly TacticalExerciseCandidateRequestBody[];
  readonly runsPerCandidate: number;
  /** 省略時はサーバーが生成し、応答へ載せる（同じ結果を再現できるようにするため）。 */
  readonly seed?: string;
}
