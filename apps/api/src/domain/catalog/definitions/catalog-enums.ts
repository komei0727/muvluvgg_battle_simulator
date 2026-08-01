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

/** M7-002（Issue #185）: `MODIFY_RESOURCE`は`HP`も対象にできる（HP_DIRECT_COST、防御力・会心を経由しない直接消費）。`SkillDefinition.cost.resource`はAP/PP/EX_GAUGEのみ（`skill-definition.ts`が独自に狭い`RESOURCE_KINDS`で検証する）。 */
export type ResourceKind = "AP" | "PP" | "EX_GAUGE" | "HP";

export type DurationTimeUnit = "ACTION" | "TURN" | "BATTLE" | "HIT" | "SKILL_USE";

export type DurationOwner = "EFFECT_TARGET" | "EFFECT_SOURCE" | "BATTLE";

export type ConsumptionKind =
  | "NEXT_OUTGOING_ATTACK"
  | "NEXT_INCOMING_ATTACK"
  | "INCOMING_HIT"
  | "OUTGOING_HIT"
  | "STATUS_BLOCKED"
  | "LETHAL_DAMAGE";

/**
 * R-STA-01の`stat`候補（`14_Catalog定義スキーマ.md`「APPLY_STAT_MOD」）。M7-001E
 * （Issue #248）で`ConditionDefinition.TARGET_HAS_EFFECT.statKinds`も同じ値集合を
 * 検証に使うようになったため、`effect-action-definition-factory.ts`の private const
 * からここ（値もtypeも持たない葉モジュール）へ移し、正本を1つにした
 * （`condition-definition.ts`は`effect-action-payload.ts`へ依存できない — 逆向きの
 * type importが既にあり循環になる）。
 */
export const STAT_KINDS = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
  "ACTION_SPEED",
] as const;
export type StatKind = (typeof STAT_KINDS)[number];

/**
 * R-DOT-01〜04（DMG-008、Issue #189）の継続ダメージ種別。`STAT_KINDS`と同じ理由で
 * `effect-action-payload.ts`からここへ移した（`TARGET_HAS_EFFECT.continuousDamageKinds`
 * が同じ値集合を検証に使う）。`effect-action-payload.ts`は後方互換のため再exportする。
 */
export const CONTINUOUS_DAMAGE_KINDS = ["FIXED", "BURN", "POISON"] as const;
export type ContinuousDamageKind = (typeof CONTINUOUS_DAMAGE_KINDS)[number];

/**
 * RES-004-STATUS-CONDITION（Issue #224）: `CONTINUOUS_DAMAGE_KINDS`のうち、
 * `01_ユビキタス言語.md`「状態異常」（「特殊な振る舞いを持つデバフ。気絶、炎上、毒、
 * 凍結、暗闇が定義されている」）および`戦闘システム.md`「3. 状態異常について」が
 * **状態異常として定義している**種別。R-STS-01「状態異常解除・状態異常無効は、
 * 状態異常として定義された効果だけを対象とする」の判定対象になる。
 *
 * `FIXED`（固定継続ダメージ）は含めない — どちらの正本も名前付きの状態異常として
 * 定義しておらず、`R-DOT-02`のシールド適用可否も炎上・毒とは異なる。
 *
 * `APPLY_STATUS`側の対応物は`effect-action-payload.ts`の`STATUS_AILMENT_KINDS`
 * （気絶・凍結・暗闇）であり、この2つで「定義された状態異常」5種を過不足なく覆う。
 * `effect-category-classifier.ts`が両方を読んで`AppliedEffect.categories`へ`STATUS`を
 * 焼き込むため、実行時の状態異常判定の分類元はその1関数だけになる。
 */
export const STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS = [
  "BURN",
  "POISON",
] as const satisfies readonly ContinuousDamageKind[];

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

/**
 * `REMOVE_EFFECTS`/`EFFECT_IMMUNITY`が共有する「どの種類の効果を対象にするか」の
 * 分類軸（`14_Catalog定義スキーマ.md`、R-EFF-02/03）。M7-001（Issue #181）で
 * `BUFF`（`DEBUFF`の対になる正の効果全体、`REMOVE_BUFF_CATEGORY`）・`SHIELD`・
 * `SUBUNIT`（`REMOVE_EFFECTS_CATEGORY_GAP`）を追加した。名称は歴史的経緯で
 * `EffectImmunity*`のままだが、両kindの`categories`列挙として機能する。
 */
export type EffectImmunityCategory =
  | "BUFF"
  | "DEBUFF"
  | "STATUS"
  | "MARKER"
  | "DAMAGE_MOD"
  | "SHIELD"
  | "SUBUNIT"
  | "SPECIFIC_EFFECT";

export type MarkerStackPolicy = "ADD" | "KEEP_EXISTING" | "REFRESH" | "REPLACE";

export type ResourceModifyOperation = "ADD" | "SET" | "SET_TO_MAX" | "DISTRIBUTE";

export type DamageModDirection = "OUTGOING" | "INCOMING";

export type CriticalMode = "NORMAL" | "GUARANTEED" | "PREVENTED";

export type AccuracyMode = "NORMAL" | "GUARANTEED";

export type OverhealPolicy = "DISCARD";
