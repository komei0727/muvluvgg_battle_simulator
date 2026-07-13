import type { BattleLogEvent } from "./battle-log-event.js";
import type { StateTransition } from "./battle-observation.js";
import type {
  ActionReservationResponseBody,
  BattleLogEventResponseBody,
  BattleSimulationResponseBody,
  BattleStateDeltaResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  UnitStateDeltaResponseBody,
} from "./http-contract.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import type {
  BattleUnitRosterEntry,
  BattleUnitSnapshot,
} from "../domain/battle/events/battle-state-snapshot.js";
import type { StateDelta, UnitStateDelta } from "../domain/battle/events/state-delta.js";
import type { PositionColumn } from "../domain/catalog/catalog-enums.js";
import type { BattleUnitId } from "../domain/shared/ids.js";

const SCHEMA_VERSION = 1;

const REVERSE_COLUMNS: Record<PositionColumn, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };

function combatStatusOf(hp: number): string {
  return hp === 0 ? "DEFEATED" : "ACTIVE";
}

function toUnitStateResponseBody(
  roster: BattleUnitRosterEntry,
  snapshot: BattleUnitSnapshot,
): BattleUnitStateResponseBody {
  return {
    battleUnitId: roster.battleUnitId,
    unitDefinitionId: roster.unitDefinitionId,
    side: roster.side,
    formationPosition: {
      column: REVERSE_COLUMNS[roster.position.column],
      row: roster.position.row === "FRONT" ? "FRONT" : "REAR",
    },
    coordinate: { x: roster.globalCoordinate.x, y: roster.globalCoordinate.y },
    combatStatus: combatStatusOf(snapshot.hp),
    hp: { current: snapshot.hp, maximum: roster.combatStats.maximumHp },
    resources: {
      ap: { current: snapshot.ap, maximum: roster.maximumAp },
      pp: { current: snapshot.pp, maximum: roster.maximumPp },
      extraGauge: { current: snapshot.extraGauge, maximum: roster.maximumExtraGauge },
    },
    combatStats: {
      attack: roster.combatStats.attack,
      defense: roster.combatStats.defense,
      criticalRate: roster.combatStats.criticalRate,
      actionSpeed: roster.combatStats.actionSpeed,
      affinityBonus: roster.combatStats.affinityBonus,
      criticalDamageBonus: roster.combatStats.criticalDamageBonus,
    },
    // `10_API設計.md`「BattleUnitStateResponse」: シールド・サブユニット・効果・
    // クールタイムはM5〜M8で実装されるまでDomainに存在せず、常に空/ゼロが事実。
    shields: { physical: 0, energy: 0, untyped: 0 },
    subUnits: [],
    effects: [],
    cooldowns: [],
  };
}

function toBattleStateResponseBody(
  stateVersion: number,
  snapshot: SimulateBattleResult["initialState"],
  roster: readonly BattleUnitRosterEntry[],
): BattleStateResponseBody {
  const units = roster.map((entry) => {
    const unitSnapshot = snapshot.units[entry.battleUnitId];
    if (unitSnapshot === undefined) {
      throw new Error(
        `unitRoster references a BattleUnitId absent from the state snapshot: "${entry.battleUnitId}"`,
      );
    }
    return toUnitStateResponseBody(entry, unitSnapshot);
  });
  // M3時点ではinitialState(READY)/finalState(COMPLETED)いずれも周回外・未行動
  // 予約なしの境界状態しか公開しないため、cycleNumber/actionQueueは常にこの値。
  const actionQueue: readonly ActionReservationResponseBody[] = [];
  return {
    stateVersion,
    battleStatus: snapshot.status,
    turnNumber: snapshot.currentTurn,
    cycleNumber: 0,
    units,
    actionQueue,
  };
}

function toBattleLogEventResponseBody(event: BattleLogEvent): BattleLogEventResponseBody {
  return {
    sequence: event.sequence,
    type: event.type,
    category: event.category,
    turnNumber: event.turnNumber,
    cycleNumber: event.cycleNumber,
    ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
    ...(event.skillUseId !== undefined ? { skillUseId: event.skillUseId } : {}),
    ...(event.parentSequence !== undefined ? { parentSequence: event.parentSequence } : {}),
    rootSequence: event.rootSequence,
    ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
    targetUnitIds: event.targetUnitIds,
    details: event.details,
    stateVersionBefore: event.stateVersionBefore,
    stateVersionAfter: event.stateVersionAfter,
    ...(event.stateTransitionIndex !== undefined
      ? { stateTransitionIndex: event.stateTransitionIndex }
      : {}),
  };
}

/**
 * `08_ドメインイベント.md`のフラットな`hp`/`ap`/`pp`/`extraGauge`を、
 * `10_API設計.md`「UnitStateDeltaResponse」の`hp`/`resources.{ap,pp,extraGauge}`
 * 形へ組み替える。`hp`が0を跨ぐ変化を伴う場合は、Domainが明示的には記録しない
 * `combatStatus`変化を同じ値から導出して補う（`isDefeated`と同じ規則）。
 */
function toUnitStateDeltaResponseBody(delta: UnitStateDelta): UnitStateDeltaResponseBody {
  const resources =
    delta.ap !== undefined || delta.pp !== undefined || delta.extraGauge !== undefined
      ? {
          ...(delta.ap !== undefined ? { ap: delta.ap } : {}),
          ...(delta.pp !== undefined ? { pp: delta.pp } : {}),
          ...(delta.extraGauge !== undefined ? { extraGauge: delta.extraGauge } : {}),
        }
      : undefined;
  const combatStatusBefore = delta.hp !== undefined ? combatStatusOf(delta.hp.before) : undefined;
  const combatStatusAfter = delta.hp !== undefined ? combatStatusOf(delta.hp.after) : undefined;
  const combatStatus =
    combatStatusBefore !== undefined &&
    combatStatusAfter !== undefined &&
    combatStatusBefore !== combatStatusAfter
      ? { before: combatStatusBefore, after: combatStatusAfter }
      : undefined;

  return {
    ...(delta.hp !== undefined ? { hp: delta.hp } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(combatStatus !== undefined ? { combatStatus } : {}),
  };
}

function toBattleStateDeltaResponseBody(delta: StateDelta): BattleStateDeltaResponseBody {
  const battle =
    delta.battleStatus !== undefined || delta.turnNumber !== undefined
      ? {
          ...(delta.battleStatus !== undefined ? { battleStatus: delta.battleStatus } : {}),
          ...(delta.turnNumber !== undefined ? { turnNumber: delta.turnNumber } : {}),
        }
      : undefined;
  const unitEntries = Object.entries(delta.units ?? {}) as [BattleUnitId, UnitStateDelta][];
  const units =
    unitEntries.length > 0
      ? Object.fromEntries(
          unitEntries.map(([battleUnitId, unitDelta]) => [
            battleUnitId,
            toUnitStateDeltaResponseBody(unitDelta),
          ]),
        )
      : undefined;

  return {
    ...(battle !== undefined ? { battle } : {}),
    ...(units !== undefined ? { units } : {}),
  };
}

/**
 * `10_API設計.md`「StateTransitionResponse」: `causedBySequence`/`stateVersion*`は
 * Applicationの`StateTransition`とそのまま同じ意味を持つため直接写す。
 */
function toStateTransitionResponseBody(transition: StateTransition) {
  return {
    causedBySequence: transition.causedBySequence,
    stateVersionBefore: transition.stateVersionBefore,
    stateVersionAfter: transition.stateVersionAfter,
    delta: toBattleStateDeltaResponseBody(transition.stateDelta),
  };
}

/**
 * `09_アプリケーション設計.md`のApplication Result(`SimulateBattleResult`)を
 * `10_API設計.md`のBattleSimulationResponseへ変換する。ドメインのbranded
 * type（`BattleId`/`BattleUnitId`など）はここで通常の`string`へ落ちる境界。
 */
export function toBattleSimulationResponseBody(
  result: SimulateBattleResult,
): BattleSimulationResponseBody {
  const stateTransitions = result.stateTransitions.map(toStateTransitionResponseBody);
  const finalStateVersion =
    stateTransitions.length > 0
      ? stateTransitions[stateTransitions.length - 1]!.stateVersionAfter
      : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    battleId: result.battleId,
    catalogRevision: result.catalogRevision,
    result: {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
    },
    initialState: toBattleStateResponseBody(0, result.initialState, result.unitRoster),
    finalState: toBattleStateResponseBody(finalStateVersion, result.finalState, result.unitRoster),
    events: result.events.map(toBattleLogEventResponseBody),
    stateTransitions,
  };
}
