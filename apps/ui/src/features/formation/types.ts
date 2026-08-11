// Mirrors docs/ui-design/03_API・データ連携設計.md §3 (UI input model) and
// §5.1/§5.3 (fixed 6 unit slots / 6 memory slots per side).

export type Side = "ally" | "enemy";
export type UiRow = "FRONT" | "REAR";
export type UiColumn = 0 | 1 | 2;
export type LogLevel = "SUMMARY" | "DETAILED" | "DIAGNOSTIC";

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
  /** 常に9枠。空枠（`undefined`）を許容する（UI-AC-025）。 */
  readonly gears: readonly (GearInput | undefined)[];
}

export interface SideEnhancementInput {
  readonly enabled: boolean;
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<EnhancementUnitType, number | "">>;
    readonly attributes: Readonly<Record<EnhancementAttribute, number | "">>;
  };
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

/** UI-AC-025: レベル既定200・ギア9枠すべて空。 */
export function createInitialUnitEnhancement(): UnitEnhancementInput {
  return {
    level: DEFAULT_UNIT_LEVEL,
    gears: Array.from({ length: GEAR_SLOT_COUNT }, () => undefined),
  };
}

export function createInitialDraft(): BattleDraft {
  return {
    allySlots: createSlots("ally"),
    enemySlots: createSlots("enemy"),
    allyMemoryDefinitionIds: createEmptyMemorySlots(),
    enemyMemoryDefinitionIds: createEmptyMemorySlots(),
    turnLimit: DEFAULT_TURN_LIMIT,
    logLevel: "DETAILED",
    allyEnhancement: createInitialSideEnhancement(),
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
