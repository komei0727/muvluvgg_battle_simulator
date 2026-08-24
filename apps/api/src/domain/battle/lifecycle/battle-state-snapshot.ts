import {
  toEffectSnapshot,
  toMarkerSnapshot,
  type BattleStateSnapshot,
  type BattleUnitSnapshot,
  type CooldownState,
} from "../events/state-delta.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import type { Battle } from "./battle.js";
import type { FormationPosition } from "../model/formation-input.js";
import type { GlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type {
  RuntimeCounterId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { SkillUseId } from "../../shared/event-ids.js";

export type {
  BattleResultSnapshot,
  BattleStateSnapshot,
  BattleUnitSnapshot,
} from "../events/state-delta.js";

/** Battle集約から状態差分の対象になりうる可変状態だけを射影する。 */
export function captureBattleState(battle: Battle): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = {};
  for (const unit of [...battle.allyUnits, ...battle.enemyUnits]) {
    const cooldownIds = Object.keys(unit.cooldowns) as SkillDefinitionId[];
    const cooldowns: Record<SkillDefinitionId, CooldownState> = {};
    for (const skillDefinitionId of cooldownIds) {
      const entry = unit.cooldowns[skillDefinitionId]!;
      cooldowns[skillDefinitionId] = {
        unit: entry.unit,
        remaining: entry.remaining,
        ...(entry.setActionId !== undefined ? { setActionId: entry.setActionId } : {}),
        ...(entry.setTurnNumber !== undefined ? { setTurnNumber: entry.setTurnNumber } : {}),
      };
    }
    const skillCounterSkillIds = Object.keys(unit.skillCounters ?? {}) as SkillDefinitionId[];
    const skillCounters: Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, number>>> = {};
    const skillCounterCarry: Record<
      SkillDefinitionId,
      Readonly<Record<RuntimeCounterId, number>>
    > = {};
    for (const skillDefinitionId of skillCounterSkillIds) {
      const counters = unit.skillCounters![skillDefinitionId]!;
      const values: Record<RuntimeCounterId, number> = {};
      const carryValues: Record<RuntimeCounterId, number> = {};
      for (const counterId of Object.keys(counters) as RuntimeCounterId[]) {
        values[counterId] = counters[counterId]!.value;
        if (counters[counterId]!.carry !== 0) {
          carryValues[counterId] = counters[counterId]!.carry;
        }
      }
      skillCounters[skillDefinitionId] = values;
      if (Object.keys(carryValues).length > 0) {
        skillCounterCarry[skillDefinitionId] = carryValues;
      }
    }
    const effectSequenceSkillUseIds = Object.keys(
      unit.effectSequenceCounters ?? {},
    ) as SkillUseId[];
    const effectSequenceCounters: Record<
      SkillUseId,
      Readonly<Record<RuntimeCounterId, number>>
    > = {};
    const effectSequenceCounterCarry: Record<
      SkillUseId,
      Readonly<Record<RuntimeCounterId, number>>
    > = {};
    for (const skillUseId of effectSequenceSkillUseIds) {
      const counters = unit.effectSequenceCounters![skillUseId]!;
      const values: Record<RuntimeCounterId, number> = {};
      const carryValues: Record<RuntimeCounterId, number> = {};
      for (const counterId of Object.keys(counters) as RuntimeCounterId[]) {
        values[counterId] = counters[counterId]!.value;
        if (counters[counterId]!.carry !== 0) {
          carryValues[counterId] = counters[counterId]!.carry;
        }
      }
      effectSequenceCounters[skillUseId] = values;
      if (Object.keys(carryValues).length > 0) {
        effectSequenceCounterCarry[skillUseId] = carryValues;
      }
    }
    const effective = selectEffectiveInstances(unit.appliedEffects);
    units[unit.battleUnitId] = {
      hp: unit.currentHp,
      ap: unit.currentAp,
      pp: unit.currentPp,
      extraGauge: unit.currentExtraGauge,
      maximumAp: unit.maximumAp,
      maximumPp: unit.maximumPp,
      maximumExtraGauge: unit.maximumExtraGauge,
      combatStats: unit.combatStats,
      baseCombatStats: unit.baseCombatStats,
      ...(cooldownIds.length > 0 ? { cooldowns } : {}),
      ...(unit.charge !== undefined
        ? {
            charge: {
              skillDefinitionId: unit.charge.skill.skillDefinitionId,
              startedActionId: unit.charge.startedActionId,
            },
          }
        : {}),
      ...(skillCounterSkillIds.length > 0 ? { skillCounters } : {}),
      ...(Object.keys(skillCounterCarry).length > 0 ? { skillCounterCarry } : {}),
      ...(effectSequenceSkillUseIds.length > 0 ? { effectSequenceCounters } : {}),
      ...(Object.keys(effectSequenceCounterCarry).length > 0 ? { effectSequenceCounterCarry } : {}),
      ...(unit.appliedEffects.length > 0
        ? {
            effects: unit.appliedEffects.map((effect) =>
              toEffectSnapshot(effect, effective.has(effect.effectInstanceId)),
            ),
          }
        : {}),
      ...(unit.markerStates.length > 0
        ? { markers: unit.markerStates.map((marker) => toMarkerSnapshot(marker)) }
        : {}),
    };
  }
  return {
    status: battle.status,
    currentTurn: battle.turnState.currentTurn,
    units,
    ...(battle.result !== undefined ? { result: battle.result } : {}),
    ...(battle.exercise !== undefined ? { exercise: battle.exercise.snapshot() } : {}),
  };
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
}

/** 味方陣営を先に、各陣営は配置(参加枠)順のまま列挙する（`10_API設計.md`「配列順」）。 */
export function captureUnitRoster(battle: Battle): readonly BattleUnitRosterEntry[] {
  return [...battle.allyUnits, ...battle.enemyUnits].map((unit) => ({
    battleUnitId: unit.battleUnitId,
    unitDefinitionId: unit.unitDefinitionId,
    side: unit.side,
    position: unit.position,
    globalCoordinate: unit.globalCoordinate,
    combatStats: unit.baseCombatStats,
    maximumAp: unit.maximumAp,
    maximumPp: unit.maximumPp,
    maximumExtraGauge: unit.maximumExtraGauge,
  }));
}
