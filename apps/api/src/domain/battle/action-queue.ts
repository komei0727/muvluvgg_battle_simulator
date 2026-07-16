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
 * R-ORD-01（部分実装）: APが1以上、EXゲージが満タン、または発動待ちのチャージ
 * 効果を持つユニットをキュー生成対象とする。凍結などによる発動阻害はStunned/
 * Frozenが未実装（M7）のため、チャージを持つユニットは常に阻害されていない
 * ものとして扱う（`06_戦闘状態遷移.md`「キュー生成対象」）。
 */
function isQueueEligible(unit: BattleUnit): boolean {
  if (isDefeated(unit)) {
    return false;
  }
  return (
    unit.currentAp >= 1 ||
    unit.currentExtraGauge >= unit.maximumExtraGauge ||
    unit.charge !== undefined
  );
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

/**
 * `06_戦闘状態遷移.md`「速度変化による並べ替え」(R-ORD-04 土台): 与えられた
 * `remaining`(未行動者だけの予約一覧)を、`units`が持つ現在の行動速度で
 * `R-ORD-02`により並べ直す。R-ORD-03「速度変化による並べ替えでも予約を変更
 * しない」に従い、各エントリの`reservedActionKind`は変更しない。`remaining`に
 * 含まれないユニットは、たとえ`units`に存在しても対象にしない（既に行動済み・
 * 除去済みのユニットを再導入しないため）。呼び出し側（速度変化を検出する
 * EffectAction、M7）が実際に速度が変わった場合だけ呼び出すことを想定した
 * 純粋関数で、この関数自体は変更の有無を判定しない。
 */
export function reorderRemainingQueue(
  remaining: readonly ActionReservation[],
  units: readonly BattleUnit[],
): readonly ActionReservation[] {
  const kindByUnitId = new Map(
    remaining.map((entry) => [entry.battleUnitId, entry.reservedActionKind]),
  );
  const remainingUnits = units.filter((unit) => kindByUnitId.has(unit.battleUnitId));
  const ordered = sortByActionOrder(remainingUnits);
  return ordered.map((unit) => ({
    battleUnitId: unit.battleUnitId,
    reservedActionKind: kindByUnitId.get(unit.battleUnitId)!,
  }));
}
