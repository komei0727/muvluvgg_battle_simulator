import type {
  ActionKind,
  ComparisonOperator,
  ContinuousDamageKind,
  CriticalMode,
  AccuracyMode,
  DamageModDirection,
  DamageType,
  DurationOwner,
  EffectImmunityCategory,
  MarkerStackPolicy,
  OverhealPolicy,
  ResourceKind,
  ResourceModifyOperation,
  StatKind,
} from "./catalog-enums.js";
import type { EffectActionDefinitionId, MarkerId, SkillDefinitionId } from "./catalog-ids.js";
import type { JsonPrimitive, MarkerCountCondition } from "./condition-definition.js";
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
  "CONFUSION",
  "DAMAGE_TO_HEAL",
] as const;

/**
 * TGT-004フェーズ1（Issue #167）: `AppliedEffect.statusKind`
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
 * （`STEALTH`等を指定すると、実行時の`STATUS`分類に一切一致せず免疫が黙って
 * 無効になる）。domain/catalogはdomain/battleへ
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

/**
 * R-DOT-02〜04（DMG-008、Issue #189）: 継続ダメージの種別。同じ
 * `APPLY_CONTINUOUS_DAMAGE`でもダメージ算出・重複規則・シールド適用可否が
 * 種別ごとに異なるため、Catalog側で判別できる必要がある。
 *
 * - `FIXED`（R-DOT-02 固定継続ダメージ）: スナップショット攻撃力と効果定義の
 *   倍率から固定ダメージを算出し、対応するタイプありシールド→タイプなし
 *   シールド→HPの順で適用する。
 * - `BURN`（R-DOT-03 炎上）: `FIXED`と同じ固定ダメージ算出に、最大3つまでの
 *   重複と「3つ保持時は各インスタンスのダメージをそれぞれ2倍」が加わる。
 * - `POISON`（R-DOT-04 毒）: `現在HP × 効果率`を`付与時攻撃力 × 100%`で上限した
 *   割合ダメージ。再付与は既存インスタンスへ統合する。
 *
 * `BURN`／`POISON`はシールドとサブユニットで受けない（R-SUB-01「毒、炎上など、
 * 通常シールドで受けられないダメージ」、R-LNK-02「元ダメージが毒・炎上など
 * シールド対象外なら」）。シールドを適用するのは`FIXED`だけである（R-DOT-02）。
 *
 * 省略を許さない（`UNSUPPORTED_*`ではなく必須fieldとする）のは、既定値を置くと
 * 「炎上として書いたつもりの定義が固定継続ダメージとして黙って別規則で解決される」
 * 近似が復活するためである。
 */
export { CONTINUOUS_DAMAGE_KINDS } from "./catalog-enums.js";
export type { ContinuousDamageKind } from "./catalog-enums.js";

/** G-02 (Issue #44): the DAMAGE-direction counterpart of `APPLY_CONTINUOUS_HEAL`. */
export interface ApplyContinuousDamagePayload {
  /** R-DOT-02〜04（DMG-008、Issue #189）: 固定継続ダメージ／炎上／毒の判別子。 */
  readonly continuousDamageKind: ContinuousDamageKind;
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

/**
 * `DYNAMIC_DAMAGE_MOD_CONDITION`（DMG-002、Issue #192）: `APPLY_DAMAGE_MOD`が
 * 「どのユニットの状態を見るか」を表す参照。R-DMG-04の集計はヒット1件の
 * 攻撃側・防御側の2体だけを文脈に持つため、汎用の`TargetReference`
 * （`BINDING`/`TRIGGER_SOURCE`等、付与時点にしか存在しない解決文脈を要する）
 * ではなくこの2値に限定する。
 *
 * - `EFFECT_OWNER`: この補正を保持しているユニット自身（`INCOMING`なら防御側、
 *   `OUTGOING`なら攻撃側）。
 * - `OPPONENT`: そのヒットにおける相手側（`INCOMING`なら攻撃側、`OUTGOING`なら
 *   攻撃対象）。
 */
export const DAMAGE_MOD_UNIT_REFERENCES = ["EFFECT_OWNER", "OPPONENT"] as const;
export type DamageModUnitReference = (typeof DAMAGE_MOD_UNIT_REFERENCES)[number];

/**
 * `UNIT_STATE`が参照できる`BattleUnit`のフィールド。`TargetStateField`の部分集合で、
 * `UnitDefinition`参照（`UNIT_TYPE`/`ROLE`）と未実装の状態異常追跡（`HAS_STATUS`）を
 * 除く — ダメージ解決時点（`domain/battle/combat`）ではCatalogの`unitDefinitions`
 * マップを引けないため、受理しても評価できない値を型から外す。
 */
export const DAMAGE_MOD_STATE_FIELDS = [
  "IS_ALIVE",
  "HP_RATIO",
  "ATTRIBUTE",
  "POSITION_ROW",
  "POSITION_COLUMN",
  "RESOURCE_AP",
  "RESOURCE_PP",
  "RESOURCE_EX_GAUGE",
] as const;
export type DamageModStateField = (typeof DAMAGE_MOD_STATE_FIELDS)[number];

/**
 * `DYNAMIC_DAMAGE_MOD_CONDITION`（DMG-002、Issue #192）: `APPLY_DAMAGE_MOD`が
 * 「どの攻撃に対して補正が成立するか」をヒットごとに動的評価するための条件。
 * `ConditionDefinition`（EffectStep用）とは別の型にしている — あちらの
 * `TargetReference`はEffectSequence解決中のTargetBinding・トリガーcontextを
 * 前提とするが、ここでは補正が付与された「後」の、無関係なスキル解決中の
 * ヒットで評価するため、それらの参照は原理的に解決できない。
 *
 * production由来の必要形は4つ:
 * - `SKL_KEI_JACKKNIFE_PS1`「自身のHPが最大HPの65%以上の場合にのみ」→ `UNIT_STATE`
 * - `SKL_AOI_ELEGANT_PS2`／`SKL_OLGA_VETERAN_AS2`「Xを所持している敵から受ける攻撃」
 *   → `UNIT_HAS_MARKER`
 * - `SKL_JULIE_SNOW_PS1`「自分よりもHP割合が高い相手から攻撃された場合にのみ」／
 *   `SKL_KOTOHA_REBEL_PS2`「対象のHP割合が自身より低い敵に対してのみ」
 *   → `HP_RATIO_COMPARISON`
 */
export type DamageModConditionDefinition =
  | { readonly kind: "TRUE" }
  | {
      readonly kind: "AND" | "OR";
      readonly conditions: readonly DamageModConditionDefinition[];
    }
  | { readonly kind: "NOT"; readonly condition: DamageModConditionDefinition }
  | {
      readonly kind: "UNIT_STATE";
      readonly unit: DamageModUnitReference;
      readonly field: DamageModStateField;
      readonly op: ComparisonOperator;
      readonly value: JsonPrimitive;
    }
  | {
      readonly kind: "UNIT_HAS_MARKER";
      readonly unit: DamageModUnitReference;
      readonly markerId: MarkerId;
      readonly countCondition?: MarkerCountCondition;
    }
  | {
      readonly kind: "HP_RATIO_COMPARISON";
      readonly left: DamageModUnitReference;
      readonly op: ComparisonOperator;
      readonly right: DamageModUnitReference;
    };

export interface ApplyDamageModPayload {
  readonly direction: DamageModDirection;
  readonly damageType: DamageType | null;
  readonly formula: FormulaDefinition;
  /**
   * `DYNAMIC_DAMAGE_MOD_CONDITION`（DMG-002、Issue #192）: 省略時は常に成立
   * （無条件の与/被ダメージ補正）。指定時は、この補正を集計するヒットごとに
   * 評価し、成立したヒットにだけ`formula`の評価結果を加算する。
   */
  readonly condition?: DamageModConditionDefinition;
  /**
   * R-DMG-07: 指定時、この補正はR-DMG-04の通常合成から外れ、確定した入射ダメージが
   * `op`で`formula`の評価結果と比較して真になるヒットにだけ、独立倍率
   * `max(0, 1 + 合計補正)`として適用される。`formula`の評価対象は保持者自身
   * （`source: TARGET`が補正保持者=被弾側を指す、`APPLY_STATUS.damageThreshold`と
   * 同じ規約）。`direction: INCOMING`でだけ宣言できる — 判定素材の「確定した
   * 入射ダメージ」は被弾側にしか存在しない。
   */
  readonly damageThreshold?: DamageThreshold;
  readonly stacking: { readonly mode: "STACKABLE" };
  readonly duration: DurationDefinition;
}

/**
 * `TEMP_PIERCING_GRANT`（DMG-003、Issue #196、R-DMG-03）: 保持者が**行う**攻撃へ
 * 一時的に防御貫通を付与する継続効果。`DamagePayload.piercing`が「そのDAMAGE定義
 * 自身が常に持つ静的な貫通率」であるのに対し、こちらは付与された保持者の後続の
 * DAMAGE全部へ期間中だけ上乗せする（production例: `SKL_RAMI_NEWYEAR_PS1`
 * 「大吉：相手の防御力を50%無視する」——おみくじの結果は、このスキルに**続く**
 * 自身の攻撃に適用される）。
 *
 * 3つの率はいずれも省略時0で、`DamagePayload.piercing`と同じ意味を持つ
 * （R-DMG-03）。全て0の定義は何も無視しない no-op のため、Catalog構築時点で
 * 拒否する（silent partial implementationを作らない）。
 *
 * `APPLY_DAMAGE_MOD`と同じく`stacking.mode`は`STACKABLE`のみ — 合成は
 * `combat/piercing-policy.ts`が「無視されずに残る割合の積」として行い、
 * R-EFF-05の重複なし最強選択は使わない。
 */
export interface ApplyPiercingModPayload {
  readonly defenseIgnoreRate: number;
  readonly shieldIgnoreRate: number;
  readonly damageReductionIgnoreRate: number;
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
 * ダメージを発生させる汎用バフ（不完全変換テーマとして追跡していた欠落
 * EffectAction、production例: `SKL_ELENA_MOODMAKER_EX`の
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

/**
 * R-FUP-01（Issue #474）: 保持者の次のAS/EXスキル使用の攻撃に相乗りする追撃バフ
 * （raw原文「当該攻撃に威力Xのダメージ…を追加する」、production例:
 * `SKL_SUIRAN_CHAOS_PS3`/`SKL_CHIYURU_MAZE_PS2`/`SKL_FEE_ACTOR_PS1`）。
 *
 * - `damage.formula`は付与時snapshotではなく追撃解決時に、**保持者**（攻撃した
 *   味方）を`SKILL_SOURCE`として評価する — 追撃のダメージ計算は付与者ではなく
 *   攻撃者のステータスで行うためである（`APPLY_ATTACK_DAMAGE_BONUS`との本質的な
 *   違い。会心・命中も追撃固有の判定を持たず元攻撃から継承する）
 * - `onHitEffect`は追撃ヒットが適用された対象へ付与する効果への参照。参照先は
 *   `APPLY_STAT_MOD`または`APPLY_CONTINUOUS_DAMAGE`に限る（`catalog-integrity.ts`が
 *   ロード時に拒否する）
 * - `duration.consumption`は`NEXT_OUTGOING_ATTACK`を必須にする — 「相乗りする
 *   攻撃」と「このバフを消費する攻撃」を同一に保つための構造的制約で、factoryが
 *   他の期間表現を拒否する
 */
export interface ApplyFollowUpAttackPayload {
  readonly damage: {
    readonly damageType: DamageType;
    readonly formula: FormulaDefinition;
  };
  readonly onHitEffect?: { readonly effectActionDefinitionId: EffectActionDefinitionId };
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
 * Issue #185: 合成経路（`composeResourceGainRate`／
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

/**
 * `R-CFS-01`／`R-CFS-02`（DMG-009、Issue #193、`status: CONFUSION`だけが持つ）:
 * 混乱がASの攻撃へ与える2つの数値。raw原文（`SKL_OLGA_VETERAN_EX`「鉄の女」）は
 * 「この際のダメージは30%減少する」「攻撃力と防御力の差分値の代わりに
 * 攻撃力×10%の値を使用し」であり、対象陣営の反転自体は数値を持たないため
 * この宣言には現れない（`CONFUSION`であること自体が反転を表す）。
 */
export interface ConfusionDefinition {
  /** R-CFS-02: 混乱中のAS攻撃へ掛ける混乱倍率が `1 - damageReductionRate` になる（定義域 [0, 1]）。 */
  readonly damageReductionRate: number;
  /** R-CFS-02: 攻撃力が実効防御力以下のとき、基礎ダメージへ使う攻撃力の割合（定義域 [0, 1]）。 */
  readonly lowAttackBaseDamageRate: number;
}

/**
 * `R-DTH-01`（DMG-009、Issue #193、`status: DAMAGE_TO_HEAL`だけが持つ）: 幻惑が
 * ダメージを回復へ変換するときの割合。raw原文（`SKL_TATIANA_SAGE_AS1`「遅効の
 * 毒針」）は「回復値は本来ダメージ値の70％となる」。
 */
export interface DamageToHealDefinition {
  /** 本来のダメージ量に対する回復量の割合（0以上）。 */
  readonly healRate: number;
}

export interface ApplyStatusPayload {
  readonly status: (typeof STATUS_KINDS)[number];
  readonly duration: DurationDefinition;
  readonly probability?: number;
  readonly appliesTo?: { readonly incomingActionKinds: readonly ActionKind[] };
  readonly damageAmplificationOnBreak?: number;
  readonly damageThreshold?: DamageThreshold;
  /** `status: CONFUSION`のときだけ必須（R-CFS-02）。他のstatusでは宣言できない。 */
  readonly confusion?: ConfusionDefinition;
  /** `status: DAMAGE_TO_HEAL`のときだけ必須（R-DTH-01）。他のstatusでは宣言できない。 */
  readonly damageToHeal?: DamageToHealDefinition;
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

/**
 * `SHIELD_DECAY_OVER_TIME`（DMG-004、Issue #194、R-SHD-01）: シールド残量が時間
 * 経過で段階的に減る宣言。raw原文の例は`SKL_SHIRANA_LUCKY_EX`（薄暮の宵火）
 * 「シールドは1行動に付き最大値の25%減少する」＝ `{ unit: "ACTION", ratio: 0.25 }`。
 *
 * 減少量は**付与時に確定した最大値**（`AppliedEffect.magnitude`）に対する割合で
 * あり、その時点の残量に対する割合ではない — 原文が「最大値の25%」と明示して
 * いるためで、等差で減る（4行動で枯渇する）ことがこの宣言の意味になる。
 *
 * `owner`は`DurationTimeLimit.owner`と同じ意味・同じ既定（省略時は
 * `EFFECT_TARGET`＝シールド保持者自身の行動終了時に減らす）を持ち、減算契機も
 * R-EFF-04の行動単位効果と同じCOMPLETINGタイミングを共有する。`unit`は現状
 * `ACTION`だけを許可する（production Catalogに他単位の漸減が存在せず、
 * 検証できない単位を宣言可能にしない）。
 */
export interface ShieldDecayDefinition {
  readonly unit: "ACTION";
  /** 付与時最大値に対する1単位あたりの減少割合（0 < ratio <= 1）。 */
  readonly ratio: number;
  readonly owner?: DurationOwner;
}

/**
 * G-08 (Issue #44): a damage-absorbing pool separate from HP.
 *
 * DMG-004（Issue #194、R-SHD-01）: `shieldType`はこのシールドが属するプールを
 * 表す。省略時はタイプなしシールド（あらゆるダメージタイプを吸収する）で、
 * `PHYSICAL`/`EN`を指定した場合は同じダメージタイプのヒットだけを吸収する
 * （R-SHD-02「対応しないタイプありシールドへダメージを適用しない」）。
 * production Catalogでタイプを明示するのは`ACT_LILY_SINGER_PS2_SHIELD`
 * （raw原文「ENシールド」）だけで、他はすべてタイプなしである。
 */
export interface ApplyShieldPayload {
  readonly formula: FormulaDefinition;
  readonly duration: DurationDefinition;
  /** 省略時はタイプなしシールド。 */
  readonly shieldType?: DamageType;
  /** `SHIELD_DECAY_OVER_TIME`: 省略時は漸減しない。 */
  readonly decay?: ShieldDecayDefinition;
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

/**
 * DAMAGE_LINK（`DMG-007`、Issue #187、R-LNK-01〜03）: 保持者が**受けた**ダメージと
 * 同量（`linkRate`の割合）のダメージを`linkTo`へ追加で発生させる継続効果。
 * `APPLY_HEALING_LINK`とは方向（被ダメージ／回復）も配分規則も異なる別kindである
 * — 回復リンクは保持者の回復量を転送先へ**移し替える**のに対し、ダメージリンクは
 * 元ダメージをそのまま残したうえでリンク先へ**追加で発生**させる
 * （`14_Catalog定義スキーマ.md`「`APPLY_HEALING_LINK`」）。
 *
 * `linkTo`は付与時点に解決して`AppliedEffect.damageLink.linkToUnitId`へ焼き込む
 * （`APPLY_HEALING_LINK.transferTo`と同じ「付与時snapshot」規約 — ダメージ適用
 * 時点にはTargetBindingもトリガーcontextも残っていない）。実装済みは次の2kindで、
 * それ以外は`UNSUPPORTED_DAMAGE_LINK_TARGET`としてCatalogロード時点で拒否する。
 *
 * - `SELF`: 付与者自身（`SKL_SUIRAN_CASINO_AS1`「自身以外の味方が受けたダメージの
 *   50%を自身に転送する」＝味方が保持し、リンク先は劉翠蘭自身）
 * - `BINDING`: 同じEffectSequenceが解決したTargetBinding（`SKL_DOROTHEA_PIONEER_PS1`
 *   「最も近い敵と最も遠い敵…対象同士が受けたダメージの35%を共有しあう」＝
 *   互いを指す2件のリンク、`SKL_CHIZURU_DOMESTIC_PS1`「自身が受けたダメージの35%を
 *   対象に送り込む」＝保持者が自身、リンク先が攻撃対象）
 */
export interface ApplyDamageLinkPayload {
  readonly linkTo: TargetReference;
  /**
   * この効果が保持者にとってバフとデバフのどちらかを、Catalogが
   * 明示する（省略不可）。`APPLY_TARGET_REDIRECT`/`APPLY_COVER`（常に`DEBUFF`）や
   * `APPLY_REFLECT`（常に`BUFF`）と違い、ダメージリンクは**同じkindで両向きに使われる**
   * ためである。
   *
   * - `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`は保持者（榊千鶴自身）の被ダメージを敵へ
   *   送る。保持者を利するため`BUFF`である
   * - `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`は劉翠蘭が自陣へ付与し、味方の被ダメージを
   *   自身の大きなシールドで受け止めるための味方向け効果であり`BUFF`である
   * - `ACT_DOROTHEA_PIONEER_PS1_LINK_TO_*`は敵2体へ付与し互いの被ダメージを増やす。
   *   `戦闘システム.md`「2. デバフについて」の「相手を不利にする効果」そのもので`DEBUFF`である
   *
   * `magnitude`（`linkRate`）の符号から導けないのは、割合が常に正だからである
   * （`APPLY_CONTINUOUS_DAMAGE`の`continuousDamageKind`と同じ「既定値を置かない」方針 —
   * 既定を置くと、向きを書き忘れた定義が黙って逆向きに分類され、`EFFECT_IMMUNITY`の
   * 拒否・`REMOVE_EFFECTS`の解除・`TARGET_HAS_EFFECT`の照会がすべて反対に働く）。
   */
  readonly polarity: "BUFF" | "DEBUFF";
  /**
   * R-LNK-01/02: リンク先へ発生させる割合。`0`以上`1`以下（`1`が「同量」）。
   * R-LNK-02「対象数で分割しない」のとおり、保持者が複数のリンクを持つ場合も
   * 各リンクがこの割合をそれぞれ独立に適用する（件数で割らない）。
   */
  readonly linkRate: number;
  readonly duration: DurationDefinition;
}

export interface ApplyReflectPayload {
  readonly reflectTo: TargetReference;
  readonly formula: FormulaDefinition;
  readonly timing: (typeof REFLECT_TIMINGS)[number];
  readonly allowRecursiveReflect: boolean;
  readonly duration: DurationDefinition;
}

/**
 * `SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`（DMG-005、Issue #190、R-SUB-02第3項
 * 「追加デバフが定義されている場合も対象ごとに適用する」）: 追加ダメージに
 * 付随して同じ対象へ付与する効果。効果そのものは通常の`EffectActionDefinition`
 * （raw原文の例は`SKL_SHIRANA_SORA_AS1`「攻撃対象の行動速度を20低下させる
 * デバフ（重複可）」＝`APPLY_STAT_MOD`）としてCatalogへ定義し、ここではIDだけを
 * 参照する — 付与経路・重複規則・期間解決を`APPLY_SUBUNIT`側で二重定義しない
 * ため（`EFFECT_IMMUNITY.effectActionDefinitionIds`と同じ参照方式）。
 */
export interface SubunitAdditionalDamageDebuff {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
}

export interface ApplySubunitPayload {
  readonly durability: { readonly formula: FormulaDefinition };
  readonly additionalDamage: {
    readonly formula: FormulaDefinition;
    /**
     * DMG-005（Issue #190、R-SUB-02）: 追加ダメージ自身のダメージタイプ。
     * R-SHD-02の「ダメージタイプに対応するタイプありシールド」を選ぶために必要で、
     * raw原文が明示する場合（`SKL_SHIRANA_SORA_EX`/`AS1`・`SKL_OLGA_VETERAN_PS1`/
     * `PS2`の「ENダメージを追加する」）はそれを書く。省略した場合は追加ダメージの
     * 契機になった攻撃（保持者が使ったDAMAGE EffectAction）のダメージタイプを
     * 引き継ぐ — raw原文がタイプを書いていない定義（`SKL_NADYA_SUCCESSOR_*`の
     * 「攻撃時に攻撃力×23.4%のダメージを追加する」）を、勝手にどちらかへ寄せず
     * 「その攻撃と同じ種類のダメージ」として表すためである。
     */
    readonly damageType?: DamageType;
    /** `SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`（R-SUB-02第3項）: 省略時は追加デバフなし。 */
    readonly debuff?: SubunitAdditionalDamageDebuff;
  };
  /**
   * `SUBUNIT_DURATION`（DMG-005、Issue #190）: サブユニット自身の存続期間。
   * raw原文の「3行動の間」「2行動の間」（`SKL_SHIRANA_SORA_EX`・
   * `SKL_OLGA_VETERAN_PS1`・`SKL_NADYA_SUCCESSOR_*`）を`timeLimit`で表す。
   * 期間を書いていない定義（`SKL_OLGA_VETERAN_PS2`の「カムラッドⅠ」）は
   * `timeLimit`なし＝耐久力が尽きるまで存続する、として表す。他の継続効果と
   * 同じく必須fieldにする — 省略を許すと「期間を書き忘れた定義」と「期間を
   * 持たない定義」が区別できなくなるためである。
   */
  readonly duration: DurationDefinition;
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
