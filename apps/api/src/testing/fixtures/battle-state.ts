import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type {
  BattleStateSnapshot,
  BattleUnitSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../../domain/battle/events/state-delta.js";

export interface InitialSnapshotOptions {
  readonly status?: BattleStateSnapshot["status"];
  readonly currentTurn?: number;
  /**
   * 保持効果・マーカー・クールタイムの射影は明示的に選ぶ。reducer検証は
   * 「キーの有無」まで比較するため、既定では書かず（`captureBattleState` と
   * 同じく空のユニットへキーを書かない）、検証対象のテストだけが有効化する。
   */
  readonly include?: readonly ("effects" | "markers" | "cooldowns" | "charge")[];
}

/** 実行前の `BattleStateSnapshot`（独立Reducerによる `stateDelta` 復元の起点）。 */
export function initialSnapshotFor(
  units: readonly BattleUnit[],
  options: InitialSnapshotOptions = {},
): BattleStateSnapshot {
  const include = new Set(options.include ?? []);
  return {
    status: options.status ?? "RUNNING",
    currentTurn: options.currentTurn ?? 1,
    units: Object.fromEntries(
      units.map((unit) => {
        const body: BattleUnitSnapshot = {
          hp: unit.currentHp,
          ap: unit.currentAp,
          pp: unit.currentPp,
          extraGauge: unit.currentExtraGauge,
          maximumAp: unit.maximumAp,
          maximumPp: unit.maximumPp,
          maximumExtraGauge: unit.maximumExtraGauge,
          combatStats: unit.combatStats,
          ...(include.has("cooldowns") && Object.keys(unit.cooldowns).length > 0
            ? { cooldowns: unit.cooldowns }
            : {}),
          // `BattleUnit["charge"]` は `SkillDefinition` 全体を持つ実行時の形。
          // StateDelta が運ぶ `ChargeState` は `ChargeStarted.after` と同じ射影
          // （ID2つ）なので、そちらへ合わせないと reducer の `before` 照合が落ちる。
          ...(include.has("charge") && unit.charge !== undefined
            ? {
                charge: {
                  skillDefinitionId: unit.charge.skill.skillDefinitionId,
                  startedActionId: unit.charge.startedActionId,
                },
              }
            : {}),
          ...(include.has("effects") && unit.appliedEffects.length > 0
            ? { effects: unit.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
            : {}),
          ...(include.has("markers") && unit.markerStates.length > 0
            ? { markers: unit.markerStates.map((marker) => toMarkerSnapshot(marker)) }
            : {}),
        };
        return [unit.battleUnitId, body];
      }),
    ),
  };
}

/** 記録された `stateDelta` だけを独立Reducerへ流し、最終状態を再構成する。 */
export function reconstruct(
  initial: BattleStateSnapshot,
  recorder: EventRecorder,
): BattleStateSnapshot {
  return reduceStateDeltas(
    initial,
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
  );
}
