// 行動トレース（01_UI要求・画面設計.md §8.10）のcomponent test用の戦闘ログ。
//
// 2ターンの戦闘で、ヒット（会心・シールド吸収）と割り込みPS、回復とメモリー発動による
// 効果の解除、撃破を1つずつ含む。各イベントの版は`sequence`と同じにし、状態を変える
// イベントにだけ状態遷移を置く。区間は次の8つになる。
//
//   0 戦闘開始（ターン0） / 1 ターン1開始 / 2 味方Aの行動 / 3 敵Dの行動 /
//   4 ターン1終了 / 5 ターン2開始 / 6 味方Aの行動（敵Cを撃破） / 7 戦闘終了
import type { RosterEntry } from "../entities/roster.js";
import type {
  BattleLogEventResponse,
  BattleSimulationResponse,
  BattleUnitStateResponse,
  StateTransitionResponse,
} from "../shared/api/api-contract.js";

export const TRACE_ALLY = "ally:1";
export const TRACE_ALLY_2 = "ally:2";
export const TRACE_ENEMY = "enemy:1";
export const TRACE_ENEMY_2 = "enemy:2";

export const TRACE_ROSTER: readonly RosterEntry[] = [
  {
    battleUnitId: TRACE_ALLY,
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    displayName: "【先駆】味方A",
  },
  { battleUnitId: TRACE_ALLY_2, unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "味方B" },
  { battleUnitId: TRACE_ENEMY, unitDefinitionId: "UNIT_C", side: "ENEMY", displayName: "敵C" },
  { battleUnitId: TRACE_ENEMY_2, unitDefinitionId: "UNIT_D", side: "ENEMY", displayName: "敵D" },
];

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber: number;
  readonly actionId?: string;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly sourceUnitId?: string;
  readonly sourceSide?: string;
  readonly targetUnitIds?: readonly string[];
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber,
    cycleNumber: 1,
    rootSequence: seed.sequence,
    targetUnitIds: seed.targetUnitIds ?? [],
    stateVersionBefore: seed.sequence - 1,
    stateVersionAfter: seed.sequence,
    ...(seed.actionId !== undefined ? { actionId: seed.actionId } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    ...(seed.sourceSide !== undefined ? { sourceSide: seed.sourceSide } : {}),
    details: seed.details ?? {},
  };
}

function unit(
  battleUnitId: string,
  side: string,
  column: number,
  overrides: Readonly<Record<string, unknown>> = {},
): BattleUnitStateResponse {
  return {
    battleUnitId,
    unitDefinitionId: `UNIT_${battleUnitId}`,
    side,
    formationPosition: { column, row: "FRONT" },
    combatStatus: "ACTIVE",
    hp: { current: 5000, maximum: 5000 },
    resources: {
      ap: { current: 3, maximum: 3 },
      pp: { current: 2, maximum: 3 },
      extraGauge: { current: 0, maximum: 100 },
    },
    shields: { physical: 0, energy: 0, untyped: 0 },
    effects: [],
    markers: [],
    ...overrides,
  };
}

const EVENTS: readonly BattleLogEventResponse[] = [
  event({ sequence: 1, type: "BATTLE_STARTED", turnNumber: 0, details: { turnLimit: 10 } }),
  event({ sequence: 2, type: "TURN_STARTED", turnNumber: 1, details: { turnNumber: 1 } }),
  // 味方Aの行動: 敵Cへ会心のヒット（シールド吸収あり）、敵DのPSが割り込んで敵Cへ効果を付ける
  event({
    sequence: 3,
    type: "ACTION_STARTED",
    turnNumber: 1,
    actionId: "act-1",
    sourceUnitId: TRACE_ALLY,
    details: { actorUnitId: TRACE_ALLY },
  }),
  event({
    sequence: 4,
    type: "SKILL_USE_STARTED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 3,
    sourceUnitId: TRACE_ALLY,
    details: { skillDefinitionId: "SKL_ALLY_AS" },
  }),
  event({
    sequence: 5,
    type: "TARGETS_SELECTED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 4,
    sourceUnitId: TRACE_ALLY,
    targetUnitIds: [TRACE_ENEMY],
  }),
  event({
    sequence: 6,
    type: "HIT_CONFIRMED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 5,
    sourceUnitId: TRACE_ALLY,
    targetUnitIds: [TRACE_ENEMY],
    details: { targetUnitId: TRACE_ENEMY, hitIndex: 0 },
  }),
  event({
    sequence: 7,
    type: "CRITICAL_CHECK_RESOLVED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 6,
    details: { result: true },
  }),
  event({
    sequence: 8,
    type: "DAMAGE_CALCULATED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 6,
    details: {
      targetUnitId: TRACE_ENEMY,
      hitIndex: 0,
      attackerAttack: 1000,
      effectiveDefense: 200,
      skillPower: 1.5,
      criticalMultiplier: 1.5,
      finalDamage: 1800,
    },
  }),
  event({
    sequence: 9,
    type: "DAMAGE_APPLIED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-1",
    parentSequence: 6,
    sourceUnitId: TRACE_ALLY,
    targetUnitIds: [TRACE_ENEMY],
    details: {
      targetUnitId: TRACE_ENEMY,
      hitIndex: 0,
      calculatedDamage: 1800,
      typedShieldAbsorbed: 300,
      untypedShieldAbsorbed: 0,
      hitPointDamage: 1500,
      hpBefore: 5000,
      hpAfter: 3500,
      defeated: false,
    },
  }),
  event({
    sequence: 10,
    type: "PASSIVE_ACTIVATED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-ps",
    parentSequence: 9,
    sourceUnitId: TRACE_ENEMY_2,
    details: {
      actorUnitId: TRACE_ENEMY_2,
      skillDefinitionId: "SKL_ENEMY_PS",
      ppBefore: 2,
      ppAfter: 1,
      exBefore: 0,
      exAfter: 0,
    },
  }),
  event({
    sequence: 11,
    type: "EFFECT_APPLIED",
    turnNumber: 1,
    actionId: "act-1",
    skillUseId: "su-ps",
    parentSequence: 10,
    sourceUnitId: TRACE_ENEMY_2,
    targetUnitIds: [TRACE_ENEMY],
    details: { targetUnitId: TRACE_ENEMY, effectDefinitionId: "EFF_GUARD" },
  }),
  event({
    sequence: 12,
    type: "ACTION_COMPLETED",
    turnNumber: 1,
    actionId: "act-1",
    parentSequence: 3,
    sourceUnitId: TRACE_ALLY,
  }),
  // 敵Dの行動: 敵Cを回復し、味方のメモリー発動が敵Cの効果を解除する
  event({
    sequence: 13,
    type: "ACTION_STARTED",
    turnNumber: 1,
    actionId: "act-2",
    sourceUnitId: TRACE_ENEMY_2,
    details: { actorUnitId: TRACE_ENEMY_2 },
  }),
  event({
    sequence: 14,
    type: "SKILL_USE_STARTED",
    turnNumber: 1,
    actionId: "act-2",
    skillUseId: "su-2",
    parentSequence: 13,
    sourceUnitId: TRACE_ENEMY_2,
    details: { skillDefinitionId: "SKL_ENEMY_HEAL" },
  }),
  event({
    sequence: 15,
    type: "HEAL_APPLIED",
    turnNumber: 1,
    actionId: "act-2",
    skillUseId: "su-2",
    parentSequence: 14,
    sourceUnitId: TRACE_ENEMY_2,
    targetUnitIds: [TRACE_ENEMY],
    details: { targetUnitId: TRACE_ENEMY, appliedAmount: 500 },
  }),
  event({
    sequence: 16,
    type: "MEMORY_TRIGGERED",
    turnNumber: 1,
    actionId: "act-2",
    skillUseId: "su-mem",
    parentSequence: 15,
    sourceSide: "ALLY",
    details: { memoryDefinitionId: "MEM_ALLY" },
  }),
  event({
    sequence: 17,
    type: "EFFECT_REMOVED",
    turnNumber: 1,
    actionId: "act-2",
    skillUseId: "su-mem",
    parentSequence: 16,
    sourceSide: "ALLY",
    targetUnitIds: [TRACE_ENEMY],
    details: { targetUnitId: TRACE_ENEMY, effectInstanceId: "eff-guard" },
  }),
  event({
    sequence: 18,
    type: "ACTION_COMPLETED",
    turnNumber: 1,
    actionId: "act-2",
    parentSequence: 13,
    sourceUnitId: TRACE_ENEMY_2,
  }),
  event({ sequence: 19, type: "TURN_COMPLETED", turnNumber: 1, details: { turnNumber: 1 } }),
  event({ sequence: 20, type: "TURN_STARTED", turnNumber: 2, details: { turnNumber: 2 } }),
  // 味方Aの行動: 敵Cを撃破する
  event({
    sequence: 21,
    type: "ACTION_STARTED",
    turnNumber: 2,
    actionId: "act-3",
    sourceUnitId: TRACE_ALLY,
    details: { actorUnitId: TRACE_ALLY },
  }),
  event({
    sequence: 22,
    type: "SKILL_USE_STARTED",
    turnNumber: 2,
    actionId: "act-3",
    skillUseId: "su-3",
    parentSequence: 21,
    sourceUnitId: TRACE_ALLY,
    details: { skillDefinitionId: "SKL_ALLY_AS" },
  }),
  event({
    sequence: 23,
    type: "HIT_CONFIRMED",
    turnNumber: 2,
    actionId: "act-3",
    skillUseId: "su-3",
    parentSequence: 22,
    sourceUnitId: TRACE_ALLY,
    targetUnitIds: [TRACE_ENEMY],
    details: { targetUnitId: TRACE_ENEMY, hitIndex: 0 },
  }),
  event({
    sequence: 24,
    type: "DAMAGE_APPLIED",
    turnNumber: 2,
    actionId: "act-3",
    skillUseId: "su-3",
    parentSequence: 23,
    sourceUnitId: TRACE_ALLY,
    targetUnitIds: [TRACE_ENEMY],
    details: {
      targetUnitId: TRACE_ENEMY,
      hitIndex: 0,
      calculatedDamage: 4000,
      hitPointDamage: 4000,
      hpBefore: 4000,
      hpAfter: 0,
      defeated: true,
    },
  }),
  event({
    sequence: 25,
    type: "UNIT_DEFEATED",
    turnNumber: 2,
    actionId: "act-3",
    parentSequence: 24,
    targetUnitIds: [TRACE_ENEMY],
    details: { defeatedUnitId: TRACE_ENEMY },
  }),
  event({
    sequence: 26,
    type: "ACTION_COMPLETED",
    turnNumber: 2,
    actionId: "act-3",
    parentSequence: 21,
    sourceUnitId: TRACE_ALLY,
  }),
  event({ sequence: 27, type: "BATTLE_COMPLETED", turnNumber: 2 }),
];

function transition(sequence: number, delta: Record<string, unknown>): StateTransitionResponse {
  return {
    causedBySequence: sequence,
    stateVersionBefore: sequence - 1,
    stateVersionAfter: sequence,
    delta,
  };
}

function unitDelta(battleUnitId: string, delta: Record<string, unknown>): Record<string, unknown> {
  return { units: { [battleUnitId]: delta } };
}

const GUARD_EFFECT = {
  effectInstanceId: "eff-guard",
  effectDefinitionId: "EFF_GUARD",
  category: "BUFF",
  duration: { unit: "TURN", remaining: 2 },
};

const TRANSITIONS: readonly StateTransitionResponse[] = [
  transition(4, unitDelta(TRACE_ALLY, { resources: { ap: { before: 3, after: 1 } } })),
  transition(
    9,
    unitDelta(TRACE_ENEMY, {
      hp: { before: 5000, after: 3500 },
      shields: { physical: { before: 300, after: 0 } },
    }),
  ),
  transition(10, unitDelta(TRACE_ENEMY_2, { resources: { pp: { before: 2, after: 1 } } })),
  transition(11, unitDelta(TRACE_ENEMY, { effects: { added: [GUARD_EFFECT] } })),
  transition(15, unitDelta(TRACE_ENEMY, { hp: { before: 3500, after: 4000 } })),
  transition(17, unitDelta(TRACE_ENEMY, { effects: { removed: [{ id: "eff-guard" }] } })),
  transition(24, unitDelta(TRACE_ENEMY, { hp: { before: 4000, after: 0 } })),
  transition(25, unitDelta(TRACE_ENEMY, { combatStatus: { before: "ACTIVE", after: "DEFEATED" } })),
];

/** 応答ごとに別のオブジェクトを返す（再実行で応答が変わる場面を作るため）。 */
export function createActionTraceResponse(battleId = "battle-trace"): BattleSimulationResponse {
  return {
    schemaVersion: 1,
    battleId,
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 2 },
    initialState: {
      units: [
        unit(TRACE_ALLY, "ALLY", 0),
        unit(TRACE_ALLY_2, "ALLY", 1),
        unit(TRACE_ENEMY, "ENEMY", 0, { shields: { physical: 300, energy: 0, untyped: 0 } }),
        unit(TRACE_ENEMY_2, "ENEMY", 1),
      ],
    },
    unitSummaries: [],
    events: EVENTS,
    stateTransitions: TRANSITIONS,
  };
}
