import type { BattleLogEvent } from "../observation/battle-log-event.js";
import type { StateTransition } from "../observation/battle-observation.js";
import type {
  ActionReservationResponseBody,
  BattleLogEventResponseBody,
  BattleSimulationResponseBody,
  BattleStateDeltaResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  ChargeStateResponseBody,
  CooldownStateResponseBody,
  EntityCollectionDeltaResponseBody,
  UnitStateDeltaResponseBody,
  ValueChangeBody,
} from "../contracts/http-contract.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import type {
  BattleUnitRosterEntry,
  BattleUnitSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type {
  CooldownState,
  StateDelta,
  UnitStateDelta,
} from "../../domain/battle/events/state-delta.js";
import type { PositionColumn } from "../../domain/catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";

const SCHEMA_VERSION = 1;

const REVERSE_COLUMNS: Record<PositionColumn, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };
const PERCENTAGE_POINT_SCALE = 100;

function combatStatusOf(hp: number): string {
  return hp === 0 ? "DEFEATED" : "ACTIVE";
}

/**
 * R-NUM-01: Domain内部の割合は`1.0 = 100%`で保持する。`10_API設計.md`
 * 「CombatStatsResponse」はパーセントポイントで返す契約(`criticalRate: 15`は
 * 15%)のため、公開境界でだけ100倍する。
 */
function toPercentagePoints(ratio: number): number {
  return ratio * PERCENTAGE_POINT_SCALE;
}

/**
 * `10_API設計.md`「CooldownStateResponse」: `unit`に応じて`setAtActionId`/
 * `setAtTurnNumber`のどちらか一方だけを持つdiscriminated unionを構築する。
 * Domainの`CooldownState`はこのXORをコンパイル時には強制しない（`unit`と
 * `setActionId`/`setTurnNumber`が独立したoptionalフィールドのため）ので、ここで
 * 実行時に検証する。反対側のscopeフィールドが同時に存在する場合も、黙って
 * 捨てて正常化するのではなく例外にする（M5レビュー4巡目[P3]: Domain不変条件が
 * 破れているサインを握りつぶさない）。
 */
function toCooldownStateResponseBody(
  skillDefinitionId: string,
  state: CooldownState,
): CooldownStateResponseBody {
  if (state.unit === "ACTION") {
    if (state.setActionId === undefined) {
      throw new Error(
        `cooldowns["${skillDefinitionId}"] has unit "ACTION" but no setActionId (violates the ACTION/TURN setting-scope XOR)`,
      );
    }
    if (state.setTurnNumber !== undefined) {
      throw new Error(
        `cooldowns["${skillDefinitionId}"] has unit "ACTION" but also has setTurnNumber (violates the ACTION/TURN setting-scope XOR)`,
      );
    }
    return {
      skillDefinitionId,
      unit: "ACTION",
      remaining: state.remaining,
      setAtActionId: state.setActionId,
    };
  }
  if (state.setTurnNumber === undefined) {
    throw new Error(
      `cooldowns["${skillDefinitionId}"] has unit "TURN" but no setTurnNumber (violates the ACTION/TURN setting-scope XOR)`,
    );
  }
  if (state.setActionId !== undefined) {
    throw new Error(
      `cooldowns["${skillDefinitionId}"] has unit "TURN" but also has setActionId (violates the ACTION/TURN setting-scope XOR)`,
    );
  }
  return {
    skillDefinitionId,
    unit: "TURN",
    remaining: state.remaining,
    setAtTurnNumber: state.setTurnNumber,
  };
}

/** `10_API設計.md`「BattleUnitStateResponse.cooldowns」: 残数があるスキルクールタイムだけを返す。 */
function toCooldownStateResponseBodies(
  cooldowns: BattleUnitSnapshot["cooldowns"],
): readonly CooldownStateResponseBody[] {
  if (cooldowns === undefined) {
    return [];
  }
  return (Object.entries(cooldowns) as [SkillDefinitionId, CooldownState][])
    .filter(([, state]) => state.remaining > 0)
    .map(([skillDefinitionId, state]) => toCooldownStateResponseBody(skillDefinitionId, state));
}

/** `10_API設計.md`「ChargeStateResponse.status」: M5時点のDomainはCHARGING以外の状態を生成しない。 */
function toChargeStateResponseBody(
  charge: BattleUnitSnapshot["charge"],
): ChargeStateResponseBody | undefined {
  if (charge === undefined) {
    return undefined;
  }
  return {
    skillDefinitionId: charge.skillDefinitionId,
    startedActionId: charge.startedActionId,
    status: "CHARGING",
  };
}

function toUnitStateResponseBody(
  roster: BattleUnitRosterEntry,
  snapshot: BattleUnitSnapshot,
): BattleUnitStateResponseBody {
  const charge = toChargeStateResponseBody(snapshot.charge);
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
      criticalRate: toPercentagePoints(roster.combatStats.criticalRate),
      actionSpeed: roster.combatStats.actionSpeed,
      affinityBonus: toPercentagePoints(roster.combatStats.affinityBonus),
      criticalDamageBonus: toPercentagePoints(roster.combatStats.criticalDamageBonus),
    },
    // `10_API設計.md`「BattleUnitStateResponse」: シールド・サブユニット・効果は
    // M7〜M8で実装されるまでDomainに存在せず、常に空/ゼロが事実。
    shields: { physical: 0, energy: 0, untyped: 0 },
    subUnits: [],
    effects: [],
    cooldowns: toCooldownStateResponseBodies(snapshot.cooldowns),
    ...(charge !== undefined ? { charge } : {}),
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
 * `10_API設計.md`「UnitStateDeltaResponse.cooldowns」(`EntityCollectionDelta`)。
 * `10_API設計.md`「BattleUnitStateResponse.cooldowns」の「残数があるスキルだけを
 * 返す」規則をここでも適用し、可視状態への出入りから`added`/`updated`/`removed`を
 * 導出する（before===0で新規出現=`added`、after===0で消滅=`removed`、それ以外は
 * `updated`）。`added`は`CooldownStateResponseBody`と同じ完全な形（`setAtActionId`/
 * `setAtTurnNumber`を含む）で持たせ、`stateTransitions`単体（`events`のlogLevel
 * フィルタに依存しない）から`finalState`を厳密に復元できるようにする
 * （`10_API設計.md`「差分の適用」`reconstructedFinalState === finalState`）。
 */
function toCooldownEntityCollectionDeltaResponseBody(
  cooldowns: UnitStateDelta["cooldowns"],
): EntityCollectionDeltaResponseBody | undefined {
  if (cooldowns === undefined) {
    return undefined;
  }
  const added: unknown[] = [];
  const updated: { id: string; before: unknown; after: unknown }[] = [];
  const removed: { id: string; before: unknown }[] = [];
  for (const [skillDefinitionId, change] of Object.entries(cooldowns)) {
    if (change.before === 0) {
      added.push(
        toCooldownStateResponseBody(skillDefinitionId, {
          unit: change.unit,
          remaining: change.after,
          ...(change.setActionId !== undefined ? { setActionId: change.setActionId } : {}),
          ...(change.setTurnNumber !== undefined ? { setTurnNumber: change.setTurnNumber } : {}),
        }),
      );
    } else if (change.after === 0) {
      removed.push({ id: skillDefinitionId, before: change.before });
    } else {
      updated.push({ id: skillDefinitionId, before: change.before, after: change.after });
    }
  }
  return { added, updated, removed };
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse.charge」(`ValueChange`)。「値がなくなった
 * ことを表す必要がある場合だけ`after: null`を使用する」規則に従い、Domainの
 * `undefined`(未チャージ)を`null`へ明示的に変換する。`status`はM5時点で
 * `CHARGING`以外の値を取り得ない定数のため、`toChargeStateResponseBody`と同じ値を
 * ここでも補い、`ChargeStateResponseBody`と同じ完全な形にする(`reconstructedFinalState
 * === finalState`)。
 */
function toChargeValueChangeResponseBody(
  charge: UnitStateDelta["charge"],
): ValueChangeBody<unknown> | undefined {
  if (charge === undefined) {
    return undefined;
  }
  return {
    before:
      charge.before !== undefined
        ? {
            skillDefinitionId: charge.before.skillDefinitionId,
            startedActionId: charge.before.startedActionId,
            status: "CHARGING",
          }
        : null,
    after:
      charge.after !== undefined
        ? {
            skillDefinitionId: charge.after.skillDefinitionId,
            startedActionId: charge.after.startedActionId,
            status: "CHARGING",
          }
        : null,
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
  const cooldowns = toCooldownEntityCollectionDeltaResponseBody(delta.cooldowns);
  const charge = toChargeValueChangeResponseBody(delta.charge);

  return {
    ...(delta.hp !== undefined ? { hp: delta.hp } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(combatStatus !== undefined ? { combatStatus } : {}),
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(charge !== undefined ? { charge } : {}),
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
