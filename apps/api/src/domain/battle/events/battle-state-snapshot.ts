import type { BattleResultSnapshot, ChargeState, CooldownState } from "./state-delta.js";
import type { Battle } from "../battle.js";
import type { BattleStatus } from "../battle-status.js";
import type { FormationPosition } from "../formation-input.js";
import type { GlobalCoordinate } from "../global-coordinate.js";
import type { Side } from "../side.js";
import type { CombatStats } from "../starting-combat-stats.js";
import type { SkillDefinitionId, UnitDefinitionId } from "../../catalog/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export type { BattleResultSnapshot } from "./state-delta.js";

export interface BattleUnitSnapshot {
  readonly hp: number;
  readonly ap: number;
  readonly pp: number;
  readonly extraGauge: number;
  /** 空でない場合だけ持つ(`captureBattleState`はクールタイムが1件も無いユニットへ`{}`を書かない)。 */
  readonly cooldowns?: Readonly<Record<SkillDefinitionId, CooldownState>>;
  readonly charge?: ChargeState;
}

/**
 * `08_ドメインイベント.md`「状態復元」のinitialState/finalStateに相当する、
 * Battleの可変状態だけを抜き出した不変スナップショット。`result`は勝敗確定後
 * だけ持つ（`Battle.result`と同じく、READY/RUNNING中は`undefined`）。
 */
export interface BattleStateSnapshot {
  readonly status: BattleStatus;
  readonly currentTurn: number;
  readonly units: Readonly<Record<BattleUnitId, BattleUnitSnapshot>>;
  readonly result?: BattleResultSnapshot;
}

/** Battle集約から状態差分の対象になりうる可変状態だけを射影する。 */
export function captureBattleState(battle: Battle): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = {};
  for (const unit of [...battle.allyUnits, ...battle.enemyUnits]) {
    const cooldownIds = Object.keys(unit.cooldowns) as SkillDefinitionId[];
    const cooldowns: Record<SkillDefinitionId, CooldownState> = {};
    for (const skillDefinitionId of cooldownIds) {
      const entry = unit.cooldowns[skillDefinitionId]!;
      cooldowns[skillDefinitionId] = { unit: entry.unit, remaining: entry.remaining };
    }
    units[unit.battleUnitId] = {
      hp: unit.currentHp,
      ap: unit.currentAp,
      pp: unit.currentPp,
      extraGauge: unit.currentExtraGauge,
      ...(cooldownIds.length > 0 ? { cooldowns } : {}),
      ...(unit.charge !== undefined
        ? {
            charge: {
              skillDefinitionId: unit.charge.skill.skillDefinitionId,
              startedActionId: unit.charge.startedActionId,
            },
          }
        : {}),
    };
  }
  return {
    status: battle.status,
    currentTurn: battle.turnState.currentTurn,
    units,
    ...(battle.result !== undefined ? { result: battle.result } : {}),
  };
}

/**
 * `10_API設計.md`「BattleUnitStateResponse」のうち、`BattleUnit`生成後は戦闘中
 * 不変な項目（配置、座標、開始戦闘ステータス、リソース最大値）だけを抜き出した
 * 静的roster。可変値(HP/AP/PP/EX)は`captureBattleState`が別途持つ。
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
}

/** 味方陣営を先に、各陣営は配置(参加枠)順のまま列挙する（`10_API設計.md`「配列順」）。 */
export function captureUnitRoster(battle: Battle): readonly BattleUnitRosterEntry[] {
  return [...battle.allyUnits, ...battle.enemyUnits].map((unit) => ({
    battleUnitId: unit.battleUnitId,
    unitDefinitionId: unit.unitDefinitionId,
    side: unit.side,
    position: unit.position,
    globalCoordinate: unit.globalCoordinate,
    combatStats: unit.combatStats,
    maximumAp: unit.maximumAp,
    maximumPp: unit.maximumPp,
    maximumExtraGauge: unit.maximumExtraGauge,
  }));
}
