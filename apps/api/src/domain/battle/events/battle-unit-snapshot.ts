import {
  toEffectSnapshot,
  toMarkerSnapshot,
  type BattleUnitSnapshot,
  type CooldownState,
} from "./state-delta.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { SkillUseId } from "../../shared/event-ids.js";

/**
 * 1ユニット分の可変状態を射影する。`captureBattleState`と、総力戦で出撃したユニットの
 * 開始状態（`StateDelta.addedUnits`）が同じ形を使う — 2つの射影が分かれると、
 * 途中で加わったユニットだけ`initialState + 全差分 = finalState`が成り立たなくなる。
 * `Battle`に依存しないモジュールに置くのは、集約（`battle.ts`）から呼ぶためである。
 */
export function captureBattleUnitSnapshot(unit: BattleUnit): BattleUnitSnapshot {
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
  const effectSequenceSkillUseIds = Object.keys(unit.effectSequenceCounters ?? {}) as SkillUseId[];
  const effectSequenceCounters: Record<SkillUseId, Readonly<Record<RuntimeCounterId, number>>> = {};
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
  return {
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
    ...(unit.cumulativeDamageDealt !== undefined
      ? { cumulativeDamageDealt: unit.cumulativeDamageDealt }
      : {}),
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
