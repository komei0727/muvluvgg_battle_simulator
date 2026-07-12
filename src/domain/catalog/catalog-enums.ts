/** Shared literal-union enums used across Catalog v2 Definition types. */

export type Attribute = "AGGRESSIVE" | "SHY" | "CUTE" | "SMART" | "COMICAL" | "CLEVER";

export type UnitType = "PHYSICAL" | "ENERGY" | "AGILE";

export type Role = "PHYSICAL_ATTACKER" | "EN_ATTACKER" | "TANK" | "SUPPORT" | "CONTROL";

export type PositionRow = "FRONT" | "BACK";

export type PositionColumn = "LEFT" | "CENTER" | "RIGHT";

export type DamageType = "PHYSICAL" | "EN";

export type Side = "ALLY" | "ENEMY" | "ALL";

export type ComparisonOperator = "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ" | "IN" | "CONTAINS";

export type SkillType = "AS" | "PS" | "EX";

export type ResourceKind = "AP" | "PP" | "EX_GAUGE";

export type DurationTimeUnit = "ACTION" | "TURN" | "BATTLE" | "HIT" | "SKILL_USE";

export type DurationOwner = "EFFECT_TARGET" | "EFFECT_SOURCE" | "BATTLE";

export type ConsumptionKind =
  | "NEXT_OUTGOING_ATTACK"
  | "NEXT_INCOMING_ATTACK"
  | "INCOMING_HIT"
  | "OUTGOING_HIT"
  | "STATUS_BLOCKED"
  | "LETHAL_DAMAGE";

export type StatKind =
  | "MAXIMUM_HP"
  | "ATTACK"
  | "DEFENSE"
  | "CRITICAL_RATE"
  | "CRITICAL_DAMAGE_BONUS"
  | "AFFINITY_BONUS"
  | "ACTION_SPEED";

/**
 * Subset of `StatKind` that `FormationBonus` and `PositionAptitudePolicy`
 * operate over (excludes `AFFINITY_BONUS`, which is copied through from
 * `BaseStats` unmodified per R-ATR-02).
 */
export type FormationCorrectableStat =
  | "MAXIMUM_HP"
  | "ATTACK"
  | "DEFENSE"
  | "CRITICAL_RATE"
  | "ACTION_SPEED"
  | "CRITICAL_DAMAGE_BONUS";

export type StatusKind =
  | "STUN"
  | "FREEZE"
  | "BLIND"
  | "STEALTH"
  | "EVASION"
  | "DAMAGE_IMMUNITY"
  | "CRITICAL_GUARANTEE"
  | "CRITICAL_PREVENTION"
  | "GUARANTEED_HIT"
  | "HIT_EVASION";

export type TargetOrderKey =
  | "DEFAULT"
  | "NEAREST"
  | "FARTHEST"
  | "LOWEST_HP_RATIO"
  | "HIGHEST_HP_RATIO"
  | "HIGHEST_ATTACK"
  | "LOWEST_MAX_HP"
  | "HIGHEST_EX_GAUGE_RATIO"
  | "FRONT_ROW"
  | "BACK_ROW"
  | "LEFT_TO_RIGHT";

/** `07_戦闘ルール詳細.md` に定義されるドメインイベントの分類。Trigger は原則FACT/TIMINGを参照する。 */
export type EventCategory = "FACT" | "TIMING";

export type ActionKind = "DAMAGE" | "DEBUFF" | "ANY";

export type EffectImmunityCategory =
  | "DEBUFF"
  | "STATUS"
  | "MARKER"
  | "DAMAGE_MOD"
  | "SPECIFIC_EFFECT";

export type MarkerStackPolicy = "ADD" | "KEEP_EXISTING" | "REFRESH" | "REPLACE";

export type ResourceModifyOperation = "ADD" | "SET" | "SET_TO_MAX" | "DISTRIBUTE";

export type DamageModDirection = "OUTGOING" | "INCOMING";

export type CriticalMode = "NORMAL" | "GUARANTEED" | "PREVENTED";

export type AccuracyMode = "NORMAL" | "GUARANTEED";

export type OverhealPolicy = "DISCARD";
