import type {
  ActionKind,
  ComparisonOperator,
  CriticalMode,
  AccuracyMode,
  DamageModDirection,
  DamageType,
  EffectImmunityCategory,
  MarkerStackPolicy,
  OverhealPolicy,
  ResourceKind,
  ResourceModifyOperation,
  StatKind,
} from "./catalog-enums.js";
import type { EffectActionDefinitionId, MarkerId, SkillDefinitionId } from "./catalog-ids.js";
import type { DurationDefinition } from "./duration-definition.js";
import type { FormulaDefinition } from "./formula-definition.js";
import type { TargetReference } from "./references.js";

/**
 * `APPLY_STATUS`のstatus値。`14_Catalog定義スキーマ.md`が定義する固定enumで、
 * `catalog-enums.ts`に対応する公開型がないため、この値集合自体がkind別payloadの
 * 一部としてここに属する。
 */
export const STATUS_KINDS = [
  "STUN",
  "FREEZE",
  "BLIND",
  "STEALTH",
  "EVASION",
  "DAMAGE_IMMUNITY",
  "CRITICAL_GUARANTEE",
  "CRITICAL_PREVENTION",
  "GUARANTEED_HIT",
  "HIT_EVASION",
] as const;

/**
 * TGT-004フェーズ1（Issue #167、PR #234再レビュー）: `AppliedEffect.statusKind`
 * （`domain/battle/model/applied-effect.ts`）が参照する公開型。`STATUS_KINDS`は
 * このファイル内のCatalog payload検証専用だったが、ドメイン層が同じ値集合を
 * 実行時状態の識別子として再利用するため、対応する型をここで公開する。
 */
export type StatusKind = (typeof STATUS_KINDS)[number];

/**
 * R-STS-01「状態異常はデバフの一種とする」: `STATUS_KINDS`のうち、実行時に
 * `STATUS`カテゴリ（`effect-category-classifier.ts`のR-EFF-02/03分類、
 * R-EFF-09の失効・免疫判定）の対象になる本来の状態異常（気絶・凍結・暗闇）。
 * `STEALTH`/`EVASION`/`DAMAGE_IMMUNITY`等の残りは対象自身にとって有利なため
 * `BUFF`として扱われ、`STATUS`カテゴリには含まれない。`EFFECT_IMMUNITY.
 * statusKinds`（M7-001B、Issue #243、`EFFECT_IMMUNITY_STATUS_GRANULARITY`）が
 * `categories: ["STATUS"]`と組み合わせて指定できる値をこの部分集合へ制限する
 * （PR #245再レビュー[P2]: `STEALTH`等を指定すると、実行時の`STATUS`分類に
 * 一切一致せず免疫が黙って無効になっていた）。domain/catalogはdomain/battleへ
 * 依存できないため、この値集合はここを正本とし、`effect-category-classifier.ts`
 * 側がここから再利用する。
 */
export const STATUS_AILMENT_KINDS = ["STUN", "FREEZE", "BLIND"] as const;

/** `APPLY_REFLECT`のtiming値。現時点では単一値のみ定義されている。 */
export const REFLECT_TIMINGS = ["AFTER_DAMAGE_APPLIED"] as const;

/** `MODIFY_RESOURCE_CAPACITY`のoperation値。 */
export const RESOURCE_CAPACITY_OPERATIONS = ["ADD", "SET"] as const;

/** `COOLDOWN_MANIPULATION`のoperation値（Issue #129）。 */
export const COOLDOWN_MANIPULATION_OPERATIONS = ["RESET", "REDUCE"] as const;

// ---- payload types ----

export interface DamagePayload {
  readonly damageType: DamageType;
  readonly formula: FormulaDefinition;
  readonly hitCount: number;
  readonly critical: { readonly mode: CriticalMode };
  readonly accuracy: { readonly mode: AccuracyMode };
  readonly piercing: {
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
  };
  readonly damageModifiers: readonly FormulaDefinition[];
  readonly link: { readonly enabled: boolean };
}

/**
 * HEAL_DISTRIBUTE（M7-005、Issue #184）: `MODIFY_RESOURCE.operation: DISTRIBUTE`
 * のHEAL版。`EVEN`はFormula評価結果（総回復量）を、同じEffectStep内でこの
 * EffectActionが適用される対象数で等分する。省略時は`NONE`（対象ごとに評価結果
 * 全量を回復する既定動作）。
 */
export type HealDistributionPolicy = "NONE" | "EVEN";

export interface HealPayload {
  readonly formula: FormulaDefinition;
  readonly overheal: OverhealPolicy;
  readonly distribution: HealDistributionPolicy;
}

export interface ApplyContinuousHealPayload {
  readonly formula: FormulaDefinition;
  readonly timing: { readonly eventType: string; readonly targetSelector: string };
  readonly duration: DurationDefinition;
}

/** G-02 (Issue #44): the DAMAGE-direction counterpart of `APPLY_CONTINUOUS_HEAL`. */
export interface ApplyContinuousDamagePayload {
  readonly damageType: DamageType;
  readonly formula: FormulaDefinition;
  readonly timing: { readonly eventType: string; readonly targetSelector: string };
  readonly duration: DurationDefinition;
}

/**
 * R-EFF-05／R-STA-03（`STACK_LIMIT_ON_STAT_MOD`、M7-012、Issue #266）:
 * `APPLY_STAT_MOD`だけが持つ重複方針。`STACKABLE`（重複あり）は保持している
 * 全インスタンスが常に有効、`NON_STACKABLE`（重複なし）は同じ`EffectKindKey`の
 * グループ内で最も強い1件だけが有効になる（`effective-effect-selector.ts`）。
 *
 * `NON_STACKABLE`を`APPLY_STAT_MOD`に限るのは、CombatStat合成
 * （`effect-stacking-policy.ts`の`combineEffects`）だけが重複なしグループの
 * 最強選択を実装しているためである。`APPLY_DAMAGE_MOD`/`APPLY_HEALING_MOD`/
 * `APPLY_RESOURCE_GAIN_MOD`の合成経路（`composeHealingRate`等）は保持している
 * 全インスタンスを合算するだけで、`NON_STACKABLE`を受理しても何も変わらない
 * silent partial implementationになる。
 */
export const STAT_MOD_STACKING_MODES = ["STACKABLE", "NON_STACKABLE"] as const;

export type StatModStackingMode = (typeof STAT_MOD_STACKING_MODES)[number];

export interface ApplyStatModPayload {
  readonly stat: StatKind;
  readonly valueType: "RATIO" | "FIXED";
  readonly formula: FormulaDefinition;
  /**
   * `max`はR-EFF-05の重複上限（`APPLY_MARKER.stack.max`の`AppliedEffect`版、
   * production例は`ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`の「負けん気」14個に
   * 対応する攻撃力バフ）。`null`は上限なし。対象が同じ`EffectKindKey`の
   * インスタンスをこの数だけ保持している場合、それ以上の付与を行わない。
   */
  readonly stacking: { readonly mode: StatModStackingMode; readonly max: number | null };
  readonly duration: DurationDefinition;
}

export interface ApplyDamageModPayload {
  readonly direction: DamageModDirection;
  readonly damageType: DamageType | null;
  readonly formula: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

/** G-01 (Issue #44): the healing-amount counterpart of `APPLY_DAMAGE_MOD` (no `damageType` — healing isn't typed). */
export interface ApplyHealingModPayload {
  readonly direction: DamageModDirection;
  readonly formula: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

/**
 * HEALING_LINK（`M7-005-HEAL-LINK`、Issue #229、R-HEAL-04）: 保持者が得られる
 * 回復効果を、`transferRate`の割合だけ`transferTo`へ移し替える継続効果
 * （production例: `SKL_ELENA_MOODMAKER_AS1`「対象が得られる回復効果を100%自身に
 * 転送する」）。`APPLY_HEALING_MOD`が「回復量そのものを増減する」のに対し、
 * こちらは「回復量の受け取り先を移す」ため、`R-HEAL-01`の適用段階が異なる。
 *
 * `transferTo`は付与時点に解決して`AppliedEffect.healingLink.transferToUnitId`
 * へ焼き込む（`APPLY_ATTACK_DAMAGE_BONUS`の`magnitude`と同じ「付与時snapshot」
 * 規約）。実装済みは`SELF`（付与者自身）だけで、それ以外は
 * `UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET`としてCatalogロード時点で拒否する。
 */
export interface ApplyHealingLinkPayload {
  readonly transferTo: TargetReference;
  /** 転送率。`0`以上`1`以下（`1`が原文の「100%転送」）。 */
  readonly transferRate: number;
  readonly duration: DurationDefinition;
}

/**
 * ON_ATTACK_BONUS_DAMAGE_BUFF（M7-004、Issue #183）: 対象の攻撃を起点に追加
 * ダメージを発生させる汎用バフ（`docs/ddd/16_不完全変換対応予定方針.md`が
 * 追跡していた欠落EffectAction、production例: `SKL_ELENA_MOODMAKER_EX`の
 * 「攻撃時に攻撃力×15%のダメージを追加するバフ」）。`formula`は付与時点で
 * 評価し、結果を`AppliedEffect.attackDamageBonus.magnitude`として保持する
 * （`APPLY_STAT_MOD`と同じ評価規約 — 動的な毎ヒット再評価ではなく付与時snapshot）。
 * `damage-application-service.ts`が保持者自身のDAMAGE EffectActionのヒットごとに
 * 加算する。
 */
export interface ApplyAttackDamageBonusPayload {
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
}

export interface ModifyResourcePayload {
  readonly resource: ResourceKind;
  readonly operation: ResourceModifyOperation;
  readonly formula: FormulaDefinition;
  readonly bounds?: { readonly min: number; readonly max: number | "CURRENT_MAX" };
}

/** G-09 (Issue #44): raises/lowers a resource's maximum, as opposed to `MODIFY_RESOURCE`'s one-off current-value change. */
export interface ModifyResourceCapacityPayload {
  readonly resource: ResourceKind;
  readonly operation: (typeof RESOURCE_CAPACITY_OPERATIONS)[number];
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
}

/**
 * G-05（`14_Catalog定義スキーマ.md`、M7-002/Issue #185）: 一定期間、対象の
 * リソース「獲得量」自体（R-ACT-03のAP/PP消費起因のEXゲージ増加）を割合で
 * 増減させる継続効果。`APPLY_STAT_MOD`と同じ評価規約で`rateDelta`を付与時点に
 * 一度だけ評価し、結果を符号付き倍率（例: `+0.5`＝+50%）として
 * `AppliedEffect.magnitude`へ保持する。`MODIFY_RESOURCE`の一回限りの加減算
 * には適用しない。
 *
 * PRレビュー指摘[P2]（Issue #185）: 合成経路（`composeResourceGainRate`／
 * `increaseExGauge`呼び出し側）はEXゲージ増加（R-ACT-03）だけを対象にし、
 * AP/PP/HPには獲得イベント自体が存在しないため合成先を持たない。共有の
 * `ResourceKind`（AP/PP/EX_GAUGE/HP）ではなく`EX_GAUGE`単一値に絞り、
 * 「受理されるが何もしない」定義をCatalogレベルで防ぐ。
 */
export interface ApplyResourceGainModPayload {
  readonly resource: "EX_GAUGE";
  readonly rateDelta: FormulaDefinition;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

/**
 * G-06 (Issue #44): gates `DAMAGE_IMMUNITY` by the size of the incoming hit.
 * The immunity applies only when the incoming raw damage compares true
 * against `formula` via `op` (e.g. `op: GT` with a `CURRENT_HP_RATIO` formula
 * blocks only hits exceeding a fraction of the holder's current HP — a ward
 * against a single big hit, not chip damage).
 */
export interface DamageThreshold {
  readonly op: ComparisonOperator;
  readonly formula: FormulaDefinition;
}

export interface ApplyStatusPayload {
  readonly status: (typeof STATUS_KINDS)[number];
  readonly duration: DurationDefinition;
  readonly probability?: number;
  readonly appliesTo?: { readonly incomingActionKinds: readonly ActionKind[] };
  readonly damageAmplificationOnBreak?: number;
  readonly damageThreshold?: DamageThreshold;
}

export interface EffectImmunityPayload {
  readonly categories: readonly EffectImmunityCategory[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
  /**
   * M7-001B（Issue #243、`EFFECT_IMMUNITY_STATUS_GRANULARITY`、R-EFF-03、
   * `CAP_SPECIFIC_IMMUNITY`）: `categories`が`STATUS`を含む場合だけ指定できる、
   * 対象を特定の状態異常種別（気絶のみ等）へ絞り込む値。省略時は従来どおり
   * `STATUS`カテゴリ全体（状態異常すべて）を対象にする。
   */
  readonly statusKinds?: readonly StatusKind[];
  readonly duration: DurationDefinition;
  readonly maxBlocks: number | null;
}

/** G-08 (Issue #44): a damage-absorbing pool separate from HP. */
export interface ApplyShieldPayload {
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
}

/**
 * G-04 (Issue #44): immediate effect removal (as opposed to `EFFECT_IMMUNITY`,
 * which blocks future applications for a duration). Shares its `categories`
 * enum with `EFFECT_IMMUNITY` for the same reason: "which kinds of effect
 * does this target" is the same taxonomy whether blocking or clearing.
 */
export interface RemoveEffectsPayload {
  readonly categories: readonly EffectImmunityCategory[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
  /**
   * M7-001（Issue #181、`REMOVE_EFFECTS_COUNT_LIMIT`）: 解除する効果インスタンス
   * 数の上限。省略時は該当カテゴリの全効果を解除する。R-EFF-02 #3「解除数や
   * 優先順が定義されている場合はその指定に従う」に対応する（優先順の既定は
   * 付与順の古い順、`effect-removal-service.ts`）。
   */
  readonly maxRemovals?: number;
}

export interface ApplyMarkerPayload {
  readonly markerId: MarkerId;
  readonly stack: { readonly policy: MarkerStackPolicy; readonly max: number | null };
  readonly duration: DurationDefinition;
}

export interface RemoveMarkerPayload {
  readonly markerId: MarkerId;
  /**
   * M7-001（Issue #181、`REMOVE_EFFECTS_COUNT_LIMIT`）: 解除するスタック数の上限。
   * 省略時は対象Markerを全スタック解除する（従来の挙動）。`count`を指定した
   * 場合はスタック数を`count`だけ減らし、0になったインスタンスだけを除去する。
   */
  readonly count?: number;
}

export interface ApplyDeathSurvivalPayload {
  readonly trigger: { readonly lethalDamageOnly: boolean };
  readonly survivalHp: FormulaDefinition;
  readonly healAfterSurvival: FormulaDefinition | null;
  readonly duration: DurationDefinition;
}

export interface ApplyTargetRedirectPayload {
  readonly redirectTo: TargetReference;
  readonly appliesTo: { readonly actionKinds: readonly ActionKind[] };
  readonly duration: DurationDefinition;
}

export interface ApplyCoverPayload {
  readonly coverer: TargetReference;
  readonly damageShareRate: number;
  readonly guardRate: number;
  readonly appliesTo: { readonly actionKinds: readonly ActionKind[] };
  readonly duration: DurationDefinition;
}

export interface ApplyReflectPayload {
  readonly reflectTo: TargetReference;
  readonly formula: FormulaDefinition;
  readonly timing: (typeof REFLECT_TIMINGS)[number];
  readonly allowRecursiveReflect: boolean;
  readonly duration: DurationDefinition;
}

export interface ApplySubunitPayload {
  readonly durability: { readonly formula: FormulaDefinition };
  readonly additionalDamage: { readonly formula: FormulaDefinition };
}

/**
 * Issue #129 `COOLDOWN_MANIPULATION`: resets or reduces another skill's
 * cooldown. `RESET` sets the remaining count to 0; `REDUCE` subtracts
 * `amount` without going below 0. `amount` is required for `REDUCE` and
 * unused for `RESET`.
 */
export interface CooldownManipulationPayload {
  readonly targetSkillDefinitionId: SkillDefinitionId;
  readonly operation: (typeof COOLDOWN_MANIPULATION_OPERATIONS)[number];
  readonly amount?: number;
}
