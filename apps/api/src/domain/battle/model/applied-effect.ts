import type { Brand } from "../../shared/brand.js";
import type { ActionId, EffectInstanceId, SkillUseId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionKind,
  EffectImmunityCategory,
} from "../../catalog/definitions/catalog-enums.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type {
  DamageThreshold,
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
 * `07_戦闘ルール詳細.md` R-STA-03: 重複なし効果を同種としてグループ化する鍵
 * （`08_ドメインイベント.md`「EffectApplied payload」）。`14_Catalog定義スキーマ.md`
 * が明示するとおり、Catalog側の`stacking.mode`は現状`STACKABLE`しか値を持たず、
 * `kindKey`専用のauthoring fieldも定義されていない。そのためドメイン側は
 * `EffectActionDefinitionId`をそのまま`EffectKindKey`として扱う — 同じ効果
 * アクション定義からの付与だけを同種とみなす、現時点で唯一実データから導出
 * できる粒度。どの`EffectKindKey`が現在の計算へ採用されているか（R-EFF-05の
 * 最強選択）はこのIssueのスコープ外（EFF-002）で、ここでは鍵の導出だけを扱う。
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
  readonly duration: EffectDurationState;
  /** 継続ダメージ等、付与時に固定するスナップショット値（例: 付与者攻撃力）。 */
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
