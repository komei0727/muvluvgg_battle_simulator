// Mirrors docs/ui-design/03_API・データ連携設計.md §3 (UI input model) and
// §5.1/§5.3 (fixed 6 unit slots / 6 memory slots per side).
//
// draft自体の語彙（`BattleDraft`・`Side`・スロット関連型）は`entities/battle-draft.ts`
// に置く（REF-055）。ここに残るのは編成機能固有の定数テーブルと、draftの初期化・
// 派生を行うヘルパー関数。
import type {
  BattleDraft,
  EnhancementAttribute,
  EnhancementUnitType,
  ExerciseExecutionInput,
  FormationSlotInput,
  GearGrade,
  GearInput,
  GearStat,
  GearTier,
  LevelLinkInput,
  Side,
  SideEnhancementInput,
  UiColumn,
  UiRow,
  UnitEnhancementInput,
} from "../../entities/battle-draft.js";

// docs/ui-design/03_API・データ連携設計.md §3.1 (M11 強化入力).
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

/** 入力欄とクライアント違反の双方が同じ語でステータスを名指すため、表はここに1つだけ置く。 */
export const GEAR_STAT_LABELS: Readonly<Record<GearStat, string>> = {
  MAXIMUM_HP: "HP",
  ATTACK: "攻撃力",
  DEFENSE: "防御力",
  ACTION_SPEED: "行動速度",
  CRITICAL_RATE: "会心率",
  CRITICAL_DAMAGE_BONUS: "会心ダメージ",
  AFFINITY_BONUS: "属性相性",
};

/**
 * 実ゲームのギアカスタムは、1ユニットにつき同一の対象ステータスのギアを最大3個までしか
 * 装備できない。R-ENH-04 #4 は「同一の対象ステータスのギアを複数指定でき、補正割合は
 * 単純加算する」と述べるだけで枚数を制限していないため、この上限はUI入力が持つ
 * （APIの検証は後続。上限が無いと、実際には組めない構成を最適解として扱ってしまう）。
 */
export const MAX_GEARS_PER_STAT = 3;

/** ユニットの9枠から、確定済みギアだけをステータス別に数える。 */
export function gearStatCounts(
  gears: readonly (GearInput | undefined)[],
): ReadonlyMap<GearStat, number> {
  const counts = new Map<GearStat, number>();
  for (const gear of gears) {
    if (gear === undefined) {
      continue;
    }
    counts.set(gear.stat, (counts.get(gear.stat) ?? 0) + 1);
  }
  return counts;
}

/**
 * 手持ちデータ（`persistence.ts`）が持つ味方の陣営単位の育成入力。学園レベルと
 * レベルリンクはどちらも「陣営に1組しかない値」であり、編成をクリアしても引き継ぐ。
 */
export interface PlayerSideEnhancement {
  readonly academyLevels: SideEnhancementInput["academyLevels"];
  readonly levelLink: LevelLinkInput;
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
