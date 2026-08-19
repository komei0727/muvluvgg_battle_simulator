// Mirrors docs/ui-design/03_API・データ連携設計.md §3 (UI input model) and
// §5.1/§5.3 (fixed 6 unit slots / 6 memory slots per side).

export type Side = "ally" | "enemy";
export type UiRow = "FRONT" | "REAR";
export type UiColumn = 0 | 1 | 2;
/**
 * 用途は「大量実行して勝敗とユニット別集計だけを見る」(`SUMMARY`)と「効果発動を
 * 追う」(`DETAILED`)の2つしかない。`DIAGNOSTIC`は`DETAILED`と同一挙動の非推奨値に
 * なったため(docs/ddd/08_ドメインイベント.md「公開レベル」)、UIの選択肢から外す。
 * 保存済みドラフトの`"DIAGNOSTIC"`は`persistence.ts`が`"DETAILED"`へ読み替える。
 */
export type LogLevel = "SUMMARY" | "DETAILED";

/**
 * 戦術演習の実行の使い分け（Issue #539）。`SINGLE`は1回だけ実行してログを読む用途、
 * `STATISTICS`は同じ編成を大量に実行して統計量を見る用途である。演習では
 * `logLevel`の選択をこの2択が置き換える — 演習で`SUMMARY`を選ぶ動機だった
 * 「大量実行して集計を見る」は`STATISTICS`が担い、`SINGLE`は常に`DETAILED`で送る。
 */
export type ExerciseExecutionMode = "SINGLE" | "STATISTICS";

/**
 * 統計実行のパラメータ。`runCount`と`seed`は`STATISTICS`のときだけ送信へ効くが、
 * モードを往復しても入力し直さなくて済むよう`SINGLE`の間も保持する。
 * `seed`の空文字は「サーバー生成に任せる」を表す（`TacticalExerciseEvaluationRequest`
 * の`seed`は任意項目）。
 */
export interface ExerciseExecutionInput {
  readonly mode: ExerciseExecutionMode;
  readonly runCount: number | "";
  readonly seed: string;
}

// docs/ui-design/03_API・データ連携設計.md §3.1 (M11 強化入力).
export type EnhancementUnitType = "PHYSICAL" | "ENERGY" | "AGILE";
export type EnhancementAttribute = "AGGRESSIVE" | "SHY" | "CUTE" | "SMART" | "COMICAL" | "CLEVER";
export type GearStat =
  | "MAXIMUM_HP"
  | "ATTACK"
  | "DEFENSE"
  | "ACTION_SPEED"
  | "CRITICAL_RATE"
  | "CRITICAL_DAMAGE_BONUS"
  | "AFFINITY_BONUS";
export type GearTier = "II" | "III";
export type GearGrade = "D" | "C" | "B" | "A" | "S";

export const ENHANCEMENT_UNIT_TYPES: readonly EnhancementUnitType[] = [
  "PHYSICAL",
  "ENERGY",
  "AGILE",
];
export const ENHANCEMENT_ATTRIBUTES: readonly EnhancementAttribute[] = [
  "AGGRESSIVE",
  "SHY",
  "CUTE",
  "SMART",
  "COMICAL",
  "CLEVER",
];
export const GEAR_STATS: readonly GearStat[] = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "ACTION_SPEED",
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
];
export const GEAR_TIERS: readonly GearTier[] = ["II", "III"];
export const GEAR_GRADES: readonly GearGrade[] = ["D", "C", "B", "A", "S"];

export interface GearInput {
  readonly stat: GearStat;
  readonly tier: GearTier;
  readonly grade: GearGrade;
}

export interface UnitEnhancementInput {
  readonly level: number | "";
  /**
   * UI-AC-036: 陣営のレベルリンクから外した枠。リンクの反映は参照時解決
   * （`level-link.ts`）で、外れていない枠の`level`はリンク中だけ読まれない。
   */
  readonly linkExcluded: boolean;
  /** 常に9枠。空枠（`undefined`）を許容する（UI-AC-025）。 */
  readonly gears: readonly (GearInput | undefined)[];
}

/** UI-AC-035: 陣営のユニットレベルを1つの値で束ねる指定。 */
export interface LevelLinkInput {
  readonly enabled: boolean;
  readonly level: number | "";
}

export interface SideEnhancementInput {
  readonly enabled: boolean;
  readonly levelLink: LevelLinkInput;
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<EnhancementUnitType, number | "">>;
    readonly attributes: Readonly<Record<EnhancementAttribute, number | "">>;
  };
}

/**
 * 手持ちデータ（`persistence.ts`）が持つ味方の陣営単位の育成入力。学園レベルと
 * レベルリンクはどちらも「陣営に1組しかない値」であり、編成をクリアしても引き継ぐ。
 */
export interface PlayerSideEnhancement {
  readonly academyLevels: SideEnhancementInput["academyLevels"];
  readonly levelLink: LevelLinkInput;
}

export interface FormationSlotInput {
  readonly slotKey: string;
  readonly side: Side;
  readonly row: UiRow;
  readonly column: UiColumn;
  readonly unitDefinitionId?: string;
  readonly enhancement?: UnitEnhancementInput;
}

export interface BattleDraft {
  readonly allySlots: readonly FormationSlotInput[];
  readonly enemySlots: readonly FormationSlotInput[];
  readonly allyMemoryDefinitionIds: readonly (string | undefined)[];
  readonly enemyMemoryDefinitionIds: readonly (string | undefined)[];
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
  /**
   * 戦術演習モードだけが読む実行指定。draft型は両モードで共有しているため通常戦闘の
   * draftにも載るが、通常戦闘のリクエスト生成も送信可否も参照しない。
   */
  readonly exerciseExecution: ExerciseExecutionInput;
  readonly allyEnhancement: SideEnhancementInput;
  readonly enemyEnhancement: SideEnhancementInput;
}

const ROWS: readonly UiRow[] = ["FRONT", "REAR"];
const COLUMNS: readonly UiColumn[] = [0, 1, 2];
const MEMORY_SLOT_COUNT = 6;
const DEFAULT_TURN_LIMIT = 10;
export const GEAR_SLOT_COUNT = 9;
const DEFAULT_ACADEMY_LEVEL = 1;
/** R-ENH-05 #1: `baseStats`が表すレベル。UIの既定値もこれに合わせる。 */
export const DEFAULT_UNIT_LEVEL = 200;
/**
 * 統計実行の既定試行数。`tools/exercise-lab`の`lab stats --runs`の既定と揃える
 * （同じ編成をUIとローカル探索の双方で回したとき、既定のまま比べられる）。
 */
export const DEFAULT_EXERCISE_RUN_COUNT = 100;
export const MIN_EXERCISE_RUN_COUNT = 1;
/**
 * UI-AC-041: 統計実行が許す総試行数の上限。1リクエストの上限（`EVALUATION_MAX_TOTAL_RUNS`）
 * ではなく画面が受け付ける総数であり、これを超える分の分割送信は統計実行基盤が担う。
 * 上限を置くのは、桁を打ち間違えた実行が延々とブラウザを占有するのを防ぐため。
 */
export const MAX_EXERCISE_RUN_COUNT = 2000;

export function slotKeyOf(side: Side, row: UiRow, column: UiColumn): string {
  return `${side}:${row}:${column}`;
}

export function memorySlotKeyOf(side: Side, index: number): string {
  return `${side}:memory:${index}`;
}

function createSlots(side: Side): readonly FormationSlotInput[] {
  return ROWS.flatMap((row) =>
    COLUMNS.map((column) => ({ slotKey: slotKeyOf(side, row, column), side, row, column })),
  );
}

function createEmptyMemorySlots(): readonly (string | undefined)[] {
  return Array.from({ length: MEMORY_SLOT_COUNT }, () => undefined);
}

/**
 * UI-AC-023/024: トグルはOFFが既定、学園レベル9項目の既定値は1
 * （R-ENH-02 #1 の「各系統はレベル1から開始」に対応する）。
 */
function createInitialSideEnhancement(): SideEnhancementInput {
  return {
    enabled: false,
    levelLink: createInitialLevelLink(),
    academyLevels: {
      unitTypes: Object.fromEntries(
        ENHANCEMENT_UNIT_TYPES.map((unitType) => [unitType, DEFAULT_ACADEMY_LEVEL]),
      ) as SideEnhancementInput["academyLevels"]["unitTypes"],
      attributes: Object.fromEntries(
        ENHANCEMENT_ATTRIBUTES.map((attribute) => [attribute, DEFAULT_ACADEMY_LEVEL]),
      ) as SideEnhancementInput["academyLevels"]["attributes"],
    },
  };
}

/** UI-AC-035: リンクは既定OFF、リンクレベルの既定はユニットレベルと同じ200。 */
export function createInitialLevelLink(): LevelLinkInput {
  return { enabled: false, level: DEFAULT_UNIT_LEVEL };
}

/** UI-AC-041: 既定は単一実行。統計実行のパラメータは既定値を持って眠る。 */
export function createInitialExerciseExecution(): ExerciseExecutionInput {
  return { mode: "SINGLE", runCount: DEFAULT_EXERCISE_RUN_COUNT, seed: "" };
}

/** UI-AC-025: レベル既定200・ギア9枠すべて空。リンクからは外さない。 */
export function createInitialUnitEnhancement(): UnitEnhancementInput {
  return {
    level: DEFAULT_UNIT_LEVEL,
    linkExcluded: false,
    gears: Array.from({ length: GEAR_SLOT_COUNT }, () => undefined),
  };
}

/**
 * `allyPlayerEnhancement`は手持ちデータ（`persistence.ts`）からのプリフィル値。
 * 学園レベルとレベルリンクはユニット定義に依存しないため、編成をクリアしても引き継ぐ。
 */
export function createInitialDraft(allyPlayerEnhancement?: PlayerSideEnhancement): BattleDraft {
  const allyEnhancement = createInitialSideEnhancement();
  return {
    allySlots: createSlots("ally"),
    enemySlots: createSlots("enemy"),
    allyMemoryDefinitionIds: createEmptyMemorySlots(),
    enemyMemoryDefinitionIds: createEmptyMemorySlots(),
    turnLimit: DEFAULT_TURN_LIMIT,
    // ログ方針刷新2/3（Issue #464）: 既定の用途は「編成を比べるための実行」で
    // あり、必要なのは勝敗とユニット別集計だけ。詳細ログは効果発動を追うときに
    // 明示的に選ぶ（既定にすると毎回数MBのレスポンスを受け取ることになる）。
    logLevel: "SUMMARY",
    exerciseExecution: createInitialExerciseExecution(),
    allyEnhancement:
      allyPlayerEnhancement === undefined
        ? allyEnhancement
        : {
            ...allyEnhancement,
            academyLevels: allyPlayerEnhancement.academyLevels,
            levelLink: allyPlayerEnhancement.levelLink,
          },
    enemyEnhancement: createInitialSideEnhancement(),
  };
}

export function slotsForSide(draft: BattleDraft, side: Side): readonly FormationSlotInput[] {
  return side === "ally" ? draft.allySlots : draft.enemySlots;
}

export function memorySlotsForSide(
  draft: BattleDraft,
  side: Side,
): readonly (string | undefined)[] {
  return side === "ally" ? draft.allyMemoryDefinitionIds : draft.enemyMemoryDefinitionIds;
}

export function enhancementForSide(draft: BattleDraft, side: Side): SideEnhancementInput {
  return side === "ally" ? draft.allyEnhancement : draft.enemyEnhancement;
}
