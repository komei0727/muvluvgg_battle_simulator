import type { Brand } from "../../shared/brand.js";
import type { ActionId, EffectInstanceId, SkillUseId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionKind,
  DamageModDirection,
  DamageType,
  EffectImmunityCategory,
  StatKind,
} from "../../catalog/definitions/catalog-enums.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type {
  ApplySubunitPayload,
  ContinuousDamageKind,
  DamageModConditionDefinition,
  DamageThreshold,
  ShieldDecayDefinition,
  StatusKind,
} from "../../catalog/definitions/effect-action-payload.js";
import type { RuntimeCounterMap } from "./runtime-counter-state.js";

/**
 * M7-004（Issue #183、R-HIT-02/03、R-STS-03/04、R-DMG-02）: `APPLY_STATUS`の
 * `status`が`EVASION`/`BLIND`/`FREEZE`/`DAMAGE_IMMUNITY`の場合だけ持つ、Catalog
 * `ApplyStatusPayload`の残りfield。付与時点だけでなく判定・消費時点
 * （回避確率、暗闇確率、凍結解除時のダメージ増幅、ダメージ無効の`damageThreshold`
 * ゲート）でも参照するため、`EffectImmunityState`と同じ理由で`AppliedEffect`
 * インスタンス自身に保持する（Catalog定義への参照だけでは`effect-action-
 * group-resolver.ts`より下位のcombat層から引けない）。
 */
export interface StatusEffectDetails {
  readonly probability?: number;
  readonly appliesTo?: { readonly incomingActionKinds: readonly ActionKind[] };
  readonly damageAmplificationOnBreak?: number;
  readonly damageThreshold?: DamageThreshold;
}

/**
 * M7-001B（Issue #243、R-EFF-03、`EFFECT_IMMUNITY`由来の`AppliedEffect`だけが持つ）:
 * `EFFECT_IMMUNITY`のCatalog payloadをそのまま保持する（`categories`/`statusKinds`/
 * `effectActionDefinitionIds`/`maxBlocks`）ことに加え、実行時に変化する`blockedCount`
 * （このインスタンスが実際に新規付与を拒否した回数）を持つ。`maxBlocks`が`null`で
 * なければ、`blockedCount`がそれ以上になった時点でこのインスタンスは新規付与を
 * 拒否しなくなる（`duration`自体の失効・解除とは独立、`effect-immunity-service.ts`）。
 */
export interface EffectImmunityState {
  readonly categories: readonly EffectImmunityCategory[];
  readonly statusKinds?: readonly StatusKind[];
  readonly effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
  readonly maxBlocks: number | null;
  readonly blockedCount: number;
}

/**
 * R-HEAL-04（`M7-005-HEAL-LINK`、Issue #229、`APPLY_HEALING_LINK`由来の
 * `AppliedEffect`だけが持つ）: 保持者が得る回復量のうち`transferRate`の割合を
 * `transferToUnitId`へ移し替える。`transferToUnitId`はCatalogの
 * `payload.transferTo`（実装済みは`SELF`のみ）を付与時点で解決した結果であり、
 * 回復適用時点にはTargetBindingもトリガーcontextも残っていないため、
 * `StatusEffectDetails`/`EffectImmunityState`と同じ理由でインスタンス自身へ保持する。
 */
export interface HealingLinkState {
  readonly transferToUnitId: BattleUnitId;
  readonly transferRate: number;
}

/**
 * R-DMG-04（DMG-002、Issue #192、`APPLY_DAMAGE_MOD`由来の付与だけが持つ）:
 * 補正の向き・対象ダメージタイプと、ヒットごとに評価する動的条件
 * （`DYNAMIC_DAMAGE_MOD_CONDITION`）。補正値そのものは他の継続効果と同じく
 * `magnitude`（付与時点で評価済みのFormula結果、符号付き割合）に入る。
 *
 * `isAttackDamageBonus`/`statusDetails`/`immunity`と同じ理由でインスタンス自身が
 * 保持する — `combat/damage-application-service.ts`はCatalogの`effectActions`
 * マップを引けない（`domain/battle/combat`のmodule境界）。
 */
export interface DamageModifierState {
  readonly direction: DamageModDirection;
  /** `null`なら全ダメージタイプへ適用する。 */
  readonly damageType: DamageType | null;
  /** 省略時は無条件。指定時は`damage-modifier-policy.ts`がヒットごとに評価する。 */
  readonly condition?: DamageModConditionDefinition;
}

/**
 * R-SHD-01（DMG-004、Issue #194、`APPLY_SHIELD`由来の付与だけが持つ）: この効果
 * インスタンスが保持するシールドプールの区分と残量。`05_ドメインモデル.md`
 * 「ShieldState」は物理・EN・タイプなしの3プールを持つ集約状態として書かれて
 * いるが、実体はここ（インスタンスごとの残量）に置く — R-SHD-01第3項「個別
 * 消滅条件を持つ付与元は`AppliedEffect`として保持し、有効な合計値を算出する」
 * のとおり、プール自体はインスタンス集合からの導出値（`shield-policy.ts`の
 * `shieldPoolsOf`）である。
 *
 * 付与時の最大値は`AppliedEffect.magnitude`（`APPLY_STAT_MOD`と同じ「付与時
 * snapshot」規約。R-NUM-02によりFormula結果は付与直前に切り捨て済みの非負整数）で、
 * `remaining`はそこから吸収・漸減で減っていく残量である。`isAttackDamageBonus`／
 * `damageModifier`と同じ理由でインスタンス自身が持つ — `combat/`はCatalogの
 * `effectActions`マップを引けない（`domain/battle/combat`のmodule境界）。
 */
/**
 * R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003、Issue #196、`APPLY_PIERCING_MOD`由来の
 * 付与だけが持つ）: 保持者が**行う**攻撃へ期間中だけ上乗せする防御貫通率。
 *
 * 3つの率をインスタンス自身に持たせるのは`shield`/`damageModifier`と同じ理由 —
 * 合成する`combat/piercing-policy.ts`はCatalogの`effectActions`マップを引けない
 * （`domain/battle/combat`のmodule境界）。`magnitude`へ畳み込めないのは、
 * 1インスタンスが独立した3つの率を同時に持ちうるためである。
 */
export interface PiercingModifierState {
  readonly defenseIgnoreRate: number;
  readonly shieldIgnoreRate: number;
  readonly damageReductionIgnoreRate: number;
}

export interface ShieldState {
  /** `null`はタイプなしシールド（あらゆるダメージタイプを吸収する）。 */
  readonly shieldType: DamageType | null;
  /** 現在の残量。0以上、`magnitude`以下。 */
  readonly remaining: number;
  /** `SHIELD_DECAY_OVER_TIME`: 宣言がある場合だけ持つ、行動ごとの漸減。 */
  readonly decay?: ShieldDecayDefinition;
}

/**
 * R-SUB-01/02（DMG-005、Issue #190、`APPLY_SUBUNIT`由来の付与だけが持つ）: この効果
 * インスタンスが表す1体のサブユニットの残耐久力と、所持者の攻撃に追加する
 * ダメージ・デバフの定義。
 *
 * `ShieldState`と同じ構造上の位置づけを持つ — 付与時の最大耐久力は
 * `AppliedEffect.magnitude`（R-NUM-02により付与直前に切り捨て済みの非負整数）で、
 * `durability`はそこから吸収で減っていく残量である。ただしR-SUB-01第3項
 * 「サブユニットの残HPをシールド表示値へ合算できるが、内部状態は通常シールドと
 * 分ける」のとおりシールドプールとは合算せず、`10_API設計.md`も`shields`とは別の
 * `subUnits`（インスタンスごと）として公開する。
 *
 * `additionalDamage`はCatalog payloadをそのまま焼き込む（`damageModifier.condition`
 * と同じ規約）。`combat/`はCatalogの`effectActions`マップを引けない
 * （`domain/battle/combat`のmodule境界）ため、追加ダメージを解決する時点で
 * 定義を引き直せないためである。付与者の付与時攻撃力（`SUBUNIT_ADDITIONAL_DAMAGE.
 * providerAttack: SOURCE_SNAPSHOT_ATTACK`）は継続ダメージと同じく
 * `AppliedEffect.snapshot[SUBUNIT_PROVIDER_ATTACK_KEY]`が持つ。
 */
export interface SubUnitState {
  /** 現在の残耐久力。0以上、`magnitude`以下。 */
  readonly durability: number;
  readonly additionalDamage: ApplySubunitPayload["additionalDamage"];
}

/** R-SUB-02: `AppliedEffect.snapshot`がサブユニット付与者の付与時攻撃力へ使うキー。 */
export const SUBUNIT_PROVIDER_ATTACK_KEY = "subUnitProviderAttack";

/**
 * R-DOT-01〜04（DMG-008、Issue #189、`APPLY_CONTINUOUS_DAMAGE`由来の付与だけが持つ）:
 * この効果インスタンスが発生させる継続ダメージの種別とダメージタイプ。
 *
 * 種別をインスタンス自身に持たせるのは、判定側がCatalogの`effectActions`マップを
 * 引かずに済ませる必要があるためである（`shield`/`damageModifier`と同じ理由）。
 * - R-DOT-03「最大3つまで保持する」の重複数は、保持者が持つ**全ての**炎上
 *   インスタンスを定義をまたいで数える（`EffectKindKey`単位ではない）
 * - R-DOT-04の再付与統合は、既存インスタンスが毒かどうかを付与の前に判定する
 *
 * 付与時攻撃力のスナップショット（R-DOT-01）は`AppliedEffect.snapshot.sourceAttack`
 * が持つ（`05_ドメインモデル.md`「継続ダメージでは、付与時の付与者攻撃力を
 * スナップショットとして保持する」）。
 */
export interface ContinuousDamageState {
  readonly continuousDamageKind: ContinuousDamageKind;
  readonly damageType: DamageType;
}

/** R-DOT-01: `AppliedEffect.snapshot`が継続ダメージの付与時攻撃力へ使うキー。 */
export const CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY = "sourceAttack";

/**
 * `07_戦闘ルール詳細.md` R-STA-03: 重複なし効果を同種としてグループ化する鍵
 * （`08_ドメインイベント.md`「EffectApplied payload」）。`14_Catalog定義スキーマ.md`
 * には`kindKey`専用のauthoring fieldが定義されていない（M7-012／Issue #266が
 * `APPLY_STAT_MOD.stacking.mode: NON_STACKABLE`と重複上限`stacking.max`を
 * 追加したが、同種グループの単位を明示する field は依然として無い）。そのため
 * ドメイン側は`EffectActionDefinitionId`をそのまま`EffectKindKey`として扱う —
 * 同じ効果アクション定義からの付与だけを同種とみなす、現時点で唯一実データから
 * 導出できる粒度。この鍵はR-EFF-05の最強選択（`effective-effect-selector.ts`）と
 * 重複上限（`isStackLimitReached`）の両方が使う。
 *
 * この導出規則はplaceholderであり、確定した公開契約ではない
 * （PR #207レビュー[P2]）: 異なるスキル由来の同種効果（例: 2つの異なるASが
 * 与える「攻撃力+10%」）を同じ`kindKey`へグループ化できないため、将来
 * R-STA-03の導出規則自体を差し替える可能性が高い。この値は`EffectApplied`
 * イベントの`details.kindKey`として`BattleLogEventResponse`経由で外部公開
 * される。EFF-003（Issue #159）が`CAP_STAT_MOD`を`IMPLEMENTED`にしたため、
 * `APPLY_STAT_MOD`由来の`EffectApplied`は実際にproduction battleで発行され
 * 得る — 外部依存が生じた場合はこのplaceholder規則の見直しを優先する。
 */
export type EffectKindKey = Brand<string, "EffectKindKey">;

export function effectKindKeyFromDefinitionId(id: EffectActionDefinitionId): EffectKindKey {
  return id as unknown as EffectKindKey;
}

/**
 * `05_ドメインモデル.md`「AppliedEffect」の`DurationState`。Catalog上の不変な
 * `DurationDefinition`と、付与後に変化する残り回数・付与scopeを分けて保持する
 * （R-EFF-01「`consumption`、`expiration`、`linkedEffectGroupId`は、回数による
 * 効果期間とは別に保持する」）。
 */
export interface EffectDurationState {
  readonly definition: DurationDefinition;
  /** `definition.timeLimit`がある場合だけ存在する。ACTION/TURN/BATTLE/HIT/SKILL_USEの残り回数。 */
  readonly timeLimitRemaining?: number;
  /** `definition.consumption`がある場合だけ存在する。消費条件の残り回数。 */
  readonly consumptionRemaining?: number;
  /** `definition.timeLimit.unit === "ACTION"`の場合、付与された行動ID（R-EFF-04の初回減算除外判定に使う）。 */
  readonly grantedActionId?: ActionId;
  /** `definition.timeLimit.unit === "TURN"`の場合、付与されたターン番号（R-EFF-06の初回減算除外判定に使う）。 */
  readonly grantedTurnNumber?: number;
  /**
   * TGT-004フェーズ1（Issue #167、PR #234再レビュー）: `definition.timeLimit.unit
   * === "SKILL_USE"`の場合、付与時の`SkillUseId`。R-EFF-04/06の初回減算除外
   * （`grantedActionId`/`grantedTurnNumber`）と同じ規約 — 付与自身のスキル使用
   * では減算しない。
   */
  readonly grantedSkillUseId?: SkillUseId;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」`AppliedEffect`スコープ（R-EFF-11、
   * EFF-005/Issue #162）。`definition.counterUpdates`が存在する場合だけ空の
   * マップから始まる（`AppliedEffect`／`MarkerState`のどちらも同じ
   * `EffectDurationState`を再利用するため、両方が対象になり得る — ただし
   * `MarkerState`の`counterUpdates`はCatalogロード時点で拒否されるため
   * 現状は`AppliedEffect`だけが実際に使う）。
   */
  readonly counters?: RuntimeCounterMap;
}

/** R-EFF-01: `DurationDefinition`から付与直後の`EffectDurationState`を組み立てる。 */
export function buildInitialDurationState(
  definition: DurationDefinition,
  context: {
    readonly actionId?: ActionId;
    readonly turnNumber: number;
    readonly skillUseId?: SkillUseId;
  },
): EffectDurationState {
  const timeLimit = definition.timeLimit;
  return {
    definition,
    ...(timeLimit !== undefined ? { timeLimitRemaining: timeLimit.count } : {}),
    ...(definition.consumption !== undefined
      ? { consumptionRemaining: definition.consumption.maxCount }
      : {}),
    ...(timeLimit?.unit === "ACTION" && context.actionId !== undefined
      ? { grantedActionId: context.actionId }
      : {}),
    ...(timeLimit?.unit === "TURN" ? { grantedTurnNumber: context.turnNumber } : {}),
    ...(timeLimit?.unit === "SKILL_USE" && context.skillUseId !== undefined
      ? { grantedSkillUseId: context.skillUseId }
      : {}),
    ...(definition.counterUpdates !== undefined && definition.counterUpdates.length > 0
      ? { counters: {} }
      : {}),
  };
}

/**
 * `05_ドメインモデル.md`「AppliedEffect」: ユニットへ付与された個別の効果
 * インスタンス。即時ダメージ・即時回復そのものは保持しない（継続効果のみ）。
 * 重複あり・重複なしのどちらも効果インスタンスと期間を個別に保持する
 * （R-EFF-01）。同種グループ内でどのインスタンスが計算に採用されるか
 * （R-EFF-05の最強選択・次点繰上げ）はEFF-002のスコープであり、このentityは
 * 選択結果を表す状態を持たない。
 */
export interface AppliedEffect {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly kindKey: EffectKindKey;
  /** true: 重複あり（同種すべてが計算に有効）。false: 重複なし（同種グループ内の最強1件だけが有効、選択はEFF-002）。 */
  readonly duplicate: boolean;
  /**
   * 付与者の戦闘ユニットID。R-MEM-04（Issue #179）: Memory の `triggeredEffects`
   * 由来の付与だけは具体的な付与者ユニットを持たないため`undefined`になり、
   * 代わりに`sourceSide`（そのMemoryを指定した陣営）を持つ
   * （`10_API設計.md`の`EffectStateResponse.sourceUnitId?`も同じ理由で任意）。
   */
  readonly sourceId?: BattleUnitId;
  /** R-MEM-04: Memory由来の付与だけが持つ、付与元の陣営（source side）。 */
  readonly sourceSide?: Side;
  readonly targetId: BattleUnitId;
  /** 効果量。符号付き（バフは正、デバフは負）。 */
  readonly magnitude: number;
  /**
   * TGT-004フェーズ1（Issue #167、PR #234/#236再レビュー）: `APPLY_STATUS`由来の
   * `AppliedEffect`だけが持つ、R-ACTN-03の分類（`StatusKind`）。他のkind
   * （`APPLY_STAT_MOD`等）由来の`AppliedEffect`は`undefined`のまま。Q-EFF-10
   * 「重複あり・重複なしのどちらも、効果インスタンスと効果期間を個別に保持する。
   * 再付与によって既存インスタンスの期間を上書きしない」により、同じ対象・同じ
   * `statusKind`への再付与も他の`APPLY_STATUS`種別（R-STS-02〜04の気絶・凍結・
   * 暗闇はそれぞれ異なる再付与規則を持つ）と同様に常に新規インスタンスを追加する
   * — Stealth固有の再付与規則（PR #234レビューで候補に挙がったREFRESH相当）は、
   * 対応するQ項目が決定されるまで導入しない（PR #236再レビュー[P1]）。
   */
  readonly statusKind?: StatusKind;
  /** M7-004（Issue #183）: `statusKind`がEVASION/BLIND/FREEZE/DAMAGE_IMMUNITYの場合だけ持つ。 */
  readonly statusDetails?: StatusEffectDetails;
  /** M7-001B（Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`由来の付与だけが持つ。 */
  readonly immunity?: EffectImmunityState;
  /**
   * M7-004（ON_ATTACK_BONUS_DAMAGE_BUFF、Issue #183）: `APPLY_ATTACK_DAMAGE_BONUS`
   * 由来の付与だけが`true`を持つkind判別子。`magnitude`（付与時点で評価済みの
   * Formula結果、`APPLY_STAT_MOD`と同じ「付与時snapshot」規約）を、保持者自身の
   * DAMAGE EffectActionのヒットごとに加算するボーナスダメージ量として扱う。
   * `combat/damage-application-service.ts`はCatalogの`effectActions`マップを
   * 引けない（`domain/battle/combat`のmodule境界）ため、`AppliedEffect`自身に
   * kindを持たせて判別する（`statusKind`/`immunity`と同じ理由）。
   */
  readonly isAttackDamageBonus?: true;
  /**
   * R-HEAL-04（`M7-005-HEAL-LINK`、Issue #229）: `APPLY_HEALING_LINK`由来の付与
   * だけが持つkind判別子。保持者が得る回復量のうち`transferRate`の割合を
   * `transferToUnitId`へ移し替える（`heal-application-service.ts`）。転送先は
   * `payload.transferTo`を付与時点で解決した結果を焼き込む
   * （`isAttackDamageBonus`の`magnitude`と同じ「付与時snapshot」規約 —
   * 回復適用時点にはTargetBindingもトリガーcontextも残っていない）。
   */
  readonly healingLink?: HealingLinkState;
  /** R-DMG-04（DMG-002、Issue #192）: `APPLY_DAMAGE_MOD`由来の付与だけが持つ。 */
  readonly damageModifier?: DamageModifierState;
  /** R-DMG-03（DMG-003、Issue #196）: `APPLY_PIERCING_MOD`由来の付与だけが持つ。 */
  readonly piercing?: PiercingModifierState;
  /** R-SHD-01（DMG-004、Issue #194）: `APPLY_SHIELD`由来の付与だけが持つ。 */
  readonly shield?: ShieldState;
  /** R-SUB-01/02（DMG-005、Issue #190）: `APPLY_SUBUNIT`由来の付与だけが持つ。 */
  readonly subUnit?: SubUnitState;
  /** R-DOT-01〜04（DMG-008、Issue #189）: `APPLY_CONTINUOUS_DAMAGE`由来の付与だけが持つ。 */
  readonly continuousDamage?: ContinuousDamageState;
  /**
   * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、R-EFF-02/03）: 付与時点に
   * `effect-category-classifier.ts`の`effectCategoriesOf`（BUFF・DEBUFF・STATUS等の
   * 唯一の分類元）で確定した分類集合を、`EffectApplied.payload.categories`と同じ
   * ソート済み配列として焼き込む。
   *
   * 分類は`definition.kind`と付与時点の`magnitude`の符号だけから決まり、付与後は
   * 変化しない（R-EFF-05「バフは正の効果量、デバフは弱化量」の`magnitude`は付与時
   * snapshot）ため、導出結果を保持しても実体と乖離しない。
   *
   * インスタンス自身に持たせる理由は`statusKind`/`shield`/`continuousDamage`と同じ
   * である — `TARGET_HAS_EFFECT`条件を評価する`effect-step-condition-evaluator.ts`／
   * `trigger-condition-evaluator.ts`はCatalogの`effectActions`マップを引けず
   * （PS trigger評価は`BattleUnit`とイベントだけを文脈に持つ）、分類のためだけに
   * 全呼び出し経路へ定義マップを通すと分類元が二重化するためである。
   */
  readonly categories: readonly EffectImmunityCategory[];
  /**
   * M7-001E（Issue #248）: `APPLY_STAT_MOD`由来の付与だけが持つ、補正対象の
   * `StatKind`（`definition.payload.stat`）。`TARGET_HAS_EFFECT.statKinds`が
   * 「対象の攻撃力にデバフがかかっているか」のようにカテゴリ判定をstat単位へ
   * 絞り込むために参照する（`SKL_SHOUKA_SCHEMER_AS3`）。`categories`と同じく
   * 定義から一意に決まる不変値を付与時点で焼き込む。
   */
  readonly statModStat?: StatKind;
  readonly duration: EffectDurationState;
  /**
   * 継続ダメージ等、付与時に固定するスナップショット値（例: 付与者攻撃力）。
   * R-DOT-01（DMG-008、Issue #189）: `APPLY_CONTINUOUS_DAMAGE`由来の付与は
   * `CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY`（`sourceAttack`）へ付与者の攻撃力を
   * 記録し、以後は付与者の攻撃力変化・戦闘不能に影響されずこの値で計算する。
   */
  readonly snapshot?: Readonly<Record<string, number>>;
  /**
   * `10_API設計.md`「EffectStateResponse」の`appliedTurnNumber`/`appliedActionId`。
   * `duration.grantedTurnNumber`/`grantedActionId`は`duration.timeLimit.unit`が
   * TURN/ACTIONの場合だけ存在するR-EFF-04/06専用の減算除外bookkeepingであり、
   * 「いつ付与されたか」を常に表す監査用フィールドとは意味が異なる（永続効果や
   * HIT/SKILL_USE/BATTLE scopeの効果ではどちらも未設定になる）。付与時点の
   * turnNumber/actionIdをここへ独立に保持する。
   */
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: ActionId;
}
