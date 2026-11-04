import type {
  BattleStateSnapshot,
  BattleUnitSnapshot,
  FormationsStateSnapshot,
} from "../events/state-delta.js";
import { captureBattleUnitSnapshot } from "../events/battle-unit-snapshot.js";
import type { TotalWarFormations, TotalWarSideFormations } from "../model/total-war-formations.js";
import type { Battle } from "./battle.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { FormationPosition } from "../model/formation-input.js";
import type { GlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export type {
  BattleResultSnapshot,
  BattleStateSnapshot,
  BattleUnitSnapshot,
} from "../events/state-delta.js";

/** Battle集約から状態差分の対象になりうる可変状態だけを射影する。 */
export function captureBattleState(battle: Battle): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = {};
  for (const unit of [...battle.allyUnits, ...battle.enemyUnits]) {
    units[unit.battleUnitId] = captureBattleUnitSnapshot(unit);
  }
  return {
    status: battle.status,
    currentTurn: battle.turnState.currentTurn,
    units,
    ...(battle.result !== undefined ? { result: battle.result } : {}),
    ...(battle.exercise !== undefined ? { exercise: battle.exercise.snapshot() } : {}),
    ...(battle.formations !== undefined
      ? { formations: captureFormationsState(battle.formations) }
      : {}),
  };
}

/**
 * 状態スナップショットへ載せる編成状態（`08_ドメインイベント.md`「総力戦イベント」）。
 * 控えのユニット・メモリー・戦闘履歴は状態差分の対象にしないため含めない。
 */
function captureFormationsState(formations: TotalWarFormations): FormationsStateSnapshot {
  const sideOf = (side: TotalWarSideFormations) => ({
    formationCount: side.formationCount,
    activeFormationNumber: side.activeFormationNumber,
    defeatedCount: side.defeatedCount,
  });
  return { ALLY: sideOf(formations.ALLY), ENEMY: sideOf(formations.ENEMY) };
}

/**
 * `10_API設計.md`「BattleUnitStateResponse」のうち、`BattleUnit`生成後は戦闘中
 * 不変な項目（配置、座標、開始戦闘ステータス、リソース最大値）だけを抜き出した
 * 静的roster。可変値(HP/AP/PP/EX)、および`R-STA-04`でAppliedEffectの付与・失効・
 * 解除のたびに再計算される現在の戦闘中ステータスは`captureBattleState`
 * （`BattleUnitSnapshot.combatStats`）が別途持つ。`combatStats`は`baseCombatStats`
 * （編成補正・適性補正だけを反映した不変の基準値）を写す — このrosterは
 * `startBattle`より前に1回だけ生成されるため、いずれの値でも現状は同じ結果に
 * なるが、意図をより正確に表す方を選ぶ。
 */
export interface BattleUnitRosterEntry {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly side: Side;
  readonly position: FormationPosition;
  readonly globalCoordinate: GlobalCoordinate;
  readonly combatStats: CombatStats;
  readonly maximumAp: number;
  readonly maximumPp: number;
  readonly maximumExtraGauge: number;
  /** 総力戦のみ。所属する編成の番号（1～3）。他のモードではキー自体を持たない。 */
  readonly formationNumber?: number;
}

/**
 * 味方陣営を先に、各陣営は配置(参加枠)順のまま列挙する（`10_API設計.md`「配列順」）。
 * 総力戦では控えの編成のユニットも含め、陣営 → 編成番号 → 配置順に並べる
 * （`10_API設計.md`「TotalWarUnitRosterResponse」）。盤面には出撃済みの編成が番号順に、
 * 控えには未出撃の編成が出撃順に並ぶため、両者を続けるだけでこの順になる。
 */
export function captureUnitRoster(battle: Battle): readonly BattleUnitRosterEntry[] {
  const reservesOf = (side: Side): readonly BattleUnit[] =>
    battle.formations?.[side].reserves.flatMap((reserve) => reserve.units) ?? [];
  return [
    ...battle.allyUnits,
    ...reservesOf("ALLY"),
    ...battle.enemyUnits,
    ...reservesOf("ENEMY"),
  ].map((unit) => ({
    battleUnitId: unit.battleUnitId,
    unitDefinitionId: unit.unitDefinitionId,
    side: unit.side,
    position: unit.position,
    globalCoordinate: unit.globalCoordinate,
    combatStats: unit.baseCombatStats,
    maximumAp: unit.maximumAp,
    maximumPp: unit.maximumPp,
    maximumExtraGauge: unit.maximumExtraGauge,
    ...(unit.formationNumber !== undefined ? { formationNumber: unit.formationNumber } : {}),
  }));
}
