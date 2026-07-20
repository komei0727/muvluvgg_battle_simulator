import type { Brand } from "../../shared/brand.js";
import type { ActionId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

/**
 * `07_戦闘ルール詳細.md` R-STA-03: 重複なし効果を同種としてグループ化する鍵。
 * `14_Catalog定義スキーマ.md`（1958行）が明示するとおり、Catalog側の
 * `stacking.mode`は現状`STACKABLE`しか値を持たず、`kindKey`のauthoring
 * fieldも定義されていない（「重複なし」に対応する値は未定義の保留仕様）。
 * そのためドメイン側は `EffectActionDefinitionId` をそのまま `EffectKindKey`
 * として扱う — 同じ効果アクション定義からの付与だけを同種とみなす、現時点で
 * 唯一実データから導出できる粒度。Catalogスキーマが専用authoring fieldを
 * 得た時点で `effectKindKeyFromDefinitionId` の実装だけを差し替えればよい。
 */
export type EffectKindKey = Brand<string, "EffectKindKey">;

export function effectKindKeyFromDefinitionId(id: EffectActionDefinitionId): EffectKindKey {
  return id as unknown as EffectKindKey;
}

/**
 * `05_ドメインモデル.md`「AppliedEffect」の`DurationState`。Catalog上の
 * 不変な`DurationDefinition`と、付与後に変化する残り回数・付与scopeを分けて
 * 保持する（R-EFF-01「`consumption`、`expiration`、`linkedEffectGroupId`は、
 * 回数による効果期間とは別に保持する」）。
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

/**
 * `05_ドメインモデル.md`「AppliedEffect」: ユニットへ付与された個別の効果
 * インスタンス。即時ダメージ・即時回復そのものは保持しない（継続効果のみ）。
 */
export interface AppliedEffect {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly kindKey: EffectKindKey;
  /** true: 重複あり（同種すべてが計算に有効）。false: 重複なし（同種グループ内の最強1件だけがactive）。 */
  readonly duplicate: boolean;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  /** 効果量。符号付き（バフは正、デバフは負）。R-STA-03の強度比較は絶対値で行う。 */
  readonly magnitude: number;
  readonly duration: EffectDurationState;
  /**
   * 重複なし効果群の中で計算に採用されている1件かどうか（R-EFF-05/R-STA-03）。
   * 重複あり効果は常にtrue。
   */
  readonly active: boolean;
  /** 継続ダメージ等、付与時に固定するスナップショット値（例: 付与者攻撃力）。 */
  readonly snapshot?: Readonly<Record<string, number>>;
}
