/**
 * Catalog全体検証が報告する違反の語彙（`11_インフラストラクチャ設計.md`の
 * 読み込み段階: Resolve → Semantic）。個々の検証moduleはこの型だけを共有し、
 * 検証結果の集約は`catalog-integrity.ts`の`buildCatalogIndex`が行う。
 */

export const VIOLATION_RULES = [
  "DUPLICATE_ID",
  "DUPLICATE_SKILL_REFERENCE",
  "DANGLING_REFERENCE",
  "TYPE_MISMATCH",
  "EX_COST_MISMATCH",
  "UNKNOWN_EVENT_TYPE",
  "EVENT_CATEGORY_MISMATCH",
  "UNOWNED_SKILL_REFERENCE",
  "UNSUPPORTED_MARKER_DURATION",
  "UNSUPPORTED_CONTINUOUS_HEAL_TIMING",
  "UNSUPPORTED_CONTINUOUS_DAMAGE_TIMING",
  "UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET",
  "UNSUPPORTED_DEFENSIVE_INTERVENTION",
  "DAMAGE_LINK_UNBOUNDED_BINDING",
  "GRANTED_BY_OUTSIDE_TRIGGER",
  "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
  "UNSUPPORTED_SOURCE_DEFEATED_REMOVAL",
  "MISSING_PRECEDING_RESULT",
  "MIXED_STEP_TARGET_SET_CONDITION",
  "BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE",
  "ACTIVATION_CONDITION_UNBOUNDED_REFERENCE",
  "ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE",
  "EVENT_PAYLOAD_REQUIRES_PS_SKILL",
  "DAMAGE_MAX_HP_RATIO_REQUIRES_TRIGGER",
  "MEMORY_REQUIRES_SOURCE_UNIT",
  "UNSUPPORTED_POINT_ADDITIVE_STAT_RATIO",
] as const;
export type CatalogIntegrityRule = (typeof VIOLATION_RULES)[number];

export interface CatalogIntegrityViolation {
  /**
   * The definition ID this violation is diagnosed against (`14_Catalog定義スキーマ.md` の ID体系).
   * Catalog定義ID（`UNIT_*`／`SKL_*`／`MEM_*` 等）であって `BattleUnitId` ではない —
   * 戦闘中の対象ユニットを指す名前は `targetUnitId` に統一されており、本フィールドとは別概念。
   */
  readonly targetId: string;
  readonly rule: CatalogIntegrityRule;
  readonly message: string;
}

/**
 * Raised by `buildCatalogIndex` with every violation found in one pass
 * (`09_アプリケーション設計.md` の Command検証と同様、可能な限りまとめて返す)
 * so a Catalog author sees every problem, not just the first.
 */
export class CatalogIntegrityError extends Error {
  readonly violations: readonly CatalogIntegrityViolation[];

  constructor(violations: readonly CatalogIntegrityViolation[]) {
    super(
      `Catalog integrity validation failed with ${violations.length} violation(s): ` +
        violations.map((v) => `[${v.rule}] ${v.targetId}: ${v.message}`).join("; "),
    );
    this.name = "CatalogIntegrityError";
    this.violations = violations;
  }
}
