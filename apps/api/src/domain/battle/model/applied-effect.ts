import type { Brand } from "../../shared/brand.js";
import type { ActionId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

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
}

/** R-EFF-01: `DurationDefinition`から付与直後の`EffectDurationState`を組み立てる。 */
export function buildInitialDurationState(
  definition: DurationDefinition,
  context: { readonly actionId?: ActionId; readonly turnNumber: number },
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
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  /** 効果量。符号付き（バフは正、デバフは負）。 */
  readonly magnitude: number;
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
