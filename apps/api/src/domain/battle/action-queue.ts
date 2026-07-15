import { sortByActionOrder } from "./action-order-policy.js";
import { isDefeated, type BattleUnit } from "./battle-unit.js";
import type { BattleUnitId } from "../shared/ids.js";

export type ReservedActionKind = "AS" | "EX";

export interface ActionReservation {
  readonly battleUnitId: BattleUnitId;
  readonly reservedActionKind: ReservedActionKind;
}

/** `ActionQueue` (`05_ドメインモデル.md`). 現在の周回で未行動のユニットと予約済み行動種別を保持する。 */
export interface ActionQueue {
  readonly entries: readonly ActionReservation[];
}

/**
 * R-ORD-01（部分実装）: APが1以上、またはEXゲージが満タンのユニットをキュー
 * 生成対象とする。発動待ちのチャージ効果はまだ存在しないため対象外
 * （`06_戦闘状態遷移.md`「キュー生成対象」）。
 */
function isQueueEligible(unit: BattleUnit): boolean {
  if (isDefeated(unit)) {
    return false;
  }
  return unit.currentAp >= 1 || unit.currentExtraGauge >= unit.maximumExtraGauge;
}

/** ActionQueue内の`ActionReservation`が持つ予約行動種別（`05_ドメインモデル.md`）。 */
function reservedActionKindOf(unit: BattleUnit): ReservedActionKind {
  return unit.currentExtraGauge >= unit.maximumExtraGauge ? "EX" : "AS";
}

/**
 * `06_戦闘状態遷移.md`「キュー生成」: 対象ユニットをActionOrderPolicy(R-ORD-02)で
 * 並べ、生成時点のEXゲージが満タンならEX、それ以外ならASを予約する。
 */
export function createActionQueue(units: readonly BattleUnit[]): ActionQueue {
  const eligible = units.filter(isQueueEligible);
  const ordered = sortByActionOrder(eligible);
  return {
    entries: ordered.map((unit) => ({
      battleUnitId: unit.battleUnitId,
      reservedActionKind: reservedActionKindOf(unit),
    })),
  };
}
