/**
 * 戦闘開始時の1解決スコープで解決される効果数が、本番Catalogで知られている限り最も多い
 * 5対5編成（両陣営ともMemory6枠）。戦闘開始時に味方全体・敵全体へ付与するMemoryと、
 * 戦闘開始時に付与の多いPS持ちユニットを組み合わせ、1枠ずつ入れ替える局所探索で
 * 必要量が増えなくなるまで詰めたもの（実測233件）。スロットは前列0〜2・後列0〜1の
 * 順に詰めて配置する。実行ガード`maxEffectsPerScope`の上限を見直す際の基準に使う。
 */
export const MEMORY_HEAVY_FORMATION = {
  ally: [
    "UNIT_KOKORO_SPORTSDAY",
    "UNIT_LILY_SINGER",
    "UNIT_LYDIA_SUMMER",
    "UNIT_INIA_CRYSKA",
    "UNIT_EVIE_ECO",
  ],
  allyMemories: [
    "MEM_SURPRISE_OPERATION",
    "MEM_DISCONTENT_AND_ANXIETY",
    "MEM_PEACEFUL_DAYS",
    "MEM_GIDDY_CIRCUMSTANCES",
    "MEM_GREATEST_FORTUNE",
    "MEM_BUSY_DAY_SLUMBER",
  ],
  enemy: [
    "UNIT_LILY_SINGER",
    "UNIT_ANIS_SWEETDEVIL",
    "UNIT_LYDIA_GENIUS",
    "UNIT_INIA_CRYSKA",
    "UNIT_KOKORO_SPORTSDAY",
  ],
  enemyMemories: [
    "MEM_BUSY_DAY_SLUMBER",
    "MEM_SURPRISE_OPERATION",
    "MEM_PEACEFUL_DAYS",
    "MEM_DISCONTENT_AND_ANXIETY",
    "MEM_GREATEST_FORTUNE",
    "MEM_GIDDY_CIRCUMSTANCES",
  ],
} as const;
