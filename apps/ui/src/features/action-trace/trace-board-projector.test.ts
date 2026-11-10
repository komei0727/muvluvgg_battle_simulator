import { describe, expect, it } from "vitest";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import { createBattleStateReplay } from "../../entities/battle-state-replay.js";
import type { RosterEntry } from "../../entities/roster.js";
import type {
  BattleLogEventResponse,
  BattleStateResponse,
  BattleUnitStateResponse,
} from "../../shared/api/api-contract.js";
import { buildRosterIndex } from "../details/event-presentation.js";
import { projectActionSegments, type ActionSegment } from "./action-segment-projector.js";
import { projectTraceBoard, selectActionOrders } from "./trace-board-projector.js";
import type { TraceUnitCardView } from "./trace-board-view.js";
import { projectTraceSteps } from "./trace-step-projector.js";

const ALLY = "ally:1";
const ALLY_2 = "ally:2";
const ENEMY = "enemy:1";
const ENEMY_2 = "enemy:2";
const ROSTER_ENTRIES: readonly RosterEntry[] = [
  { battleUnitId: ALLY, unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "【先駆】味方A" },
  { battleUnitId: ALLY_2, unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "味方B" },
  { battleUnitId: ENEMY, unitDefinitionId: "UNIT_C", side: "ENEMY", displayName: "敵C" },
  { battleUnitId: ENEMY_2, unitDefinitionId: "UNIT_D", side: "ENEMY", displayName: "敵D" },
];
const ROSTER = buildRosterIndex(ROSTER_ENTRIES);
const ACTION_ID = "B:action:1";
const MAIN = "B:skill-use:as";
const PS = "B:skill-use:ps";

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly actionId?: string | null;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly sourceUnitId?: string;
  readonly targetUnitIds?: readonly string[];
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  const actionId = seed.actionId === undefined ? ACTION_ID : seed.actionId;
  return {
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: seed.targetUnitIds ?? [],
    stateVersionBefore: seed.sequence - 1,
    stateVersionAfter: seed.sequence,
    ...(actionId !== null ? { actionId } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    details: seed.details ?? {},
  };
}

function actionStart(actor = ALLY): readonly BattleLogEventResponse[] {
  return [
    event({
      sequence: 1,
      type: "ACTION_STARTED",
      sourceUnitId: actor,
      details: { actorUnitId: actor },
    }),
    event({
      sequence: 2,
      type: "TARGETS_SELECTED",
      skillUseId: MAIN,
      parentSequence: 1,
      sourceUnitId: actor,
      targetUnitIds: [ENEMY],
    }),
    event({
      sequence: 3,
      type: "SKILL_USE_STARTED",
      skillUseId: MAIN,
      parentSequence: 2,
      sourceUnitId: actor,
    }),
  ];
}

function hitOn(
  sequence: number,
  targetUnitId: string,
  hitIndex: number,
  applied: Record<string, unknown> | undefined,
  options: {
    readonly critical?: boolean;
    readonly source?: string;
    readonly skillUseId?: string;
  } = {},
): readonly BattleLogEventResponse[] {
  const source = options.source ?? ALLY;
  const skillUseId = options.skillUseId ?? MAIN;
  const events = [
    event({
      sequence,
      type: "HIT_CONFIRMED",
      skillUseId,
      parentSequence: 3,
      sourceUnitId: source,
      targetUnitIds: [targetUnitId],
      details: { targetUnitId, hitIndex },
    }),
    event({
      sequence: sequence + 1,
      type: "CRITICAL_CHECK_RESOLVED",
      skillUseId,
      parentSequence: sequence,
      details: { result: options.critical ?? false },
    }),
  ];
  if (applied === undefined) {
    return events;
  }
  return [
    ...events,
    event({
      sequence: sequence + 2,
      type: "DAMAGE_APPLIED",
      skillUseId,
      parentSequence: sequence,
      sourceUnitId: source,
      targetUnitIds: [targetUnitId],
      details: { targetUnitId, hitIndex, ...applied },
    }),
  ];
}

function segmentOf(events: readonly BattleLogEventResponse[]): ActionSegment {
  const segments = projectActionSegments(events, ROSTER_ENTRIES);
  expect(segments).toHaveLength(1);
  return segments[0]!;
}

interface UnitSeed {
  readonly id: string;
  readonly side: string;
  readonly column: number;
  readonly row: "FRONT" | "REAR";
  readonly hp?: number;
  readonly maxHp?: number;
  readonly ap?: number;
  readonly pp?: number;
  readonly ex?: number;
  readonly shields?: { physical: number; energy: number; untyped: number };
  readonly effects?: readonly Record<string, unknown>[];
  readonly markers?: readonly Record<string, unknown>[];
  readonly charge?: Record<string, unknown>;
  readonly combatStatus?: string;
  readonly formationNumber?: number;
}

function unit(seed: UnitSeed): BattleUnitStateResponse {
  return {
    battleUnitId: seed.id,
    unitDefinitionId: "UNIT_X",
    side: seed.side,
    formationPosition: { column: seed.column, row: seed.row },
    combatStatus: seed.combatStatus ?? "ACTIVE",
    hp: { current: seed.hp ?? 1000, maximum: seed.maxHp ?? 1000 },
    resources: {
      ap: { current: seed.ap ?? 3, maximum: 4 },
      pp: { current: seed.pp ?? 1, maximum: 3 },
      extraGauge: { current: seed.ex ?? 10, maximum: 100 },
    },
    shields: seed.shields ?? { physical: 0, energy: 0, untyped: 0 },
    effects: seed.effects ?? [],
    markers: seed.markers ?? [],
    ...(seed.charge !== undefined ? { charge: seed.charge } : {}),
    ...(seed.formationNumber !== undefined ? { formationNumber: seed.formationNumber } : {}),
  };
}

const BASE: readonly UnitSeed[] = [
  { id: ALLY, side: "ALLY", column: 0, row: "FRONT" },
  { id: ALLY_2, side: "ALLY", column: 1, row: "REAR" },
  { id: ENEMY, side: "ENEMY", column: 0, row: "FRONT" },
  { id: ENEMY_2, side: "ENEMY", column: 2, row: "REAR" },
];

function state(overrides: Readonly<Record<string, Partial<UnitSeed>>> = {}): BattleStateResponse {
  return { units: BASE.map((seed) => unit({ ...seed, ...overrides[seed.id] })) };
}

function cardOf(units: readonly TraceUnitCardView[], id: string): TraceUnitCardView {
  const card = units.find((u) => u.battleUnitId === id);
  expect(card).toBeDefined();
  return card!;
}

function board(
  events: readonly BattleLogEventResponse[],
  before: BattleStateResponse,
  after: BattleStateResponse,
  options: {
    readonly stepIndex?: number;
    readonly actionOrders?: ReadonlyMap<string, number>;
  } = {},
) {
  const segment = segmentOf(events);
  const steps = projectTraceSteps(segment, ROSTER);
  return projectTraceBoard({
    before,
    after,
    segment,
    steps: options.stepIndex === undefined ? steps : [steps[options.stepIndex]!],
    roster: ROSTER,
    actionOrders: options.actionOrders ?? new Map(),
  });
}

describe("projectTraceBoard", () => {
  it("UI-UT-ATR-027: 盤面のカードが範囲の前後のHP・シールド・AP・PP・EXと配置・名前を持ち、範囲の中で出撃したユニットは後の値を前の値にする", () => {
    const view = board(
      actionStart(),
      state({
        [ENEMY]: { hp: 800, shields: { physical: 100, energy: 0, untyped: 50 }, ap: 3, ex: 40 },
      }),
      {
        units: [
          ...state({
            [ENEMY]: {
              hp: 500,
              shields: { physical: 0, energy: 0, untyped: 20 },
              ap: 1,
              pp: 2,
              ex: 60,
            },
          }).units,
          unit({ id: "enemy:9", side: "ENEMY", column: 1, row: "FRONT", hp: 700 }),
        ],
      },
      { actionOrders: new Map([[ALLY, 1]]) },
    );
    const enemy = cardOf(view.units, ENEMY);
    expect(enemy).toMatchObject({
      side: "ENEMY",
      column: 0,
      row: "FRONT",
      displayName: "敵C",
      name: "敵C",
      hp: { before: 800, after: 500, maximum: 1000 },
      shield: { before: 150, after: 20 },
      ap: { before: 3, after: 1, maximum: 4 },
      pp: { before: 1, after: 2, maximum: 3 },
      extraGauge: { before: 40, after: 60, maximum: 100 },
      defeated: false,
    });
    expect(enemy.actionOrder).toBeUndefined();
    expect(cardOf(view.units, ALLY)).toMatchObject({
      displayName: "【先駆】味方A",
      name: "味方A",
      actionOrder: 1,
    });
    // Rosterに無いユニットはIDのまま、範囲の中で出撃したので前の値は後の値
    expect(cardOf(view.units, "enemy:9")).toMatchObject({
      displayName: "enemy:9",
      hp: { before: 700, after: 700 },
    });
  });

  it("UI-UT-ATR-028: 総力戦では各陣営の出撃中の編成のユニットだけを盤面に出す", () => {
    const after: BattleStateResponse = {
      units: [
        unit({
          id: ALLY,
          side: "ALLY",
          column: 0,
          row: "FRONT",
          formationNumber: 1,
          combatStatus: "DEFEATED",
          hp: 0,
        }),
        unit({ id: ALLY_2, side: "ALLY", column: 0, row: "FRONT", formationNumber: 2 }),
        unit({ id: ENEMY, side: "ENEMY", column: 0, row: "FRONT", formationNumber: 1 }),
      ],
      formations: {
        ally: { formationCount: 2, activeFormationNumber: 2, defeatedCount: 1 },
        enemy: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
      },
    };
    const view = board(actionStart(), after, after);
    expect(view.units.map((u) => u.battleUnitId).sort()).toEqual([ALLY_2, ENEMY]);
  });

  it("UI-UT-ATR-029: 範囲内のヒットを実際に適用された対象ごとにダメージ合計・ヒット数・会心・シールド吸収へまとめ、回復を対象ごとの実回復量へまとめる", () => {
    const events = [
      ...actionStart(),
      ...hitOn(4, ENEMY, 0, {
        hitPointDamage: 300,
        typedShieldAbsorbed: 100,
        untypedShieldAbsorbed: 30,
      }),
      ...hitOn(7, ENEMY, 1, { hitPointDamage: 200, subUnitAbsorbed: 20 }, { critical: true }),
      // 肩代わりで敵Dが受けたヒット
      event({
        sequence: 10,
        type: "HIT_CONFIRMED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        targetUnitIds: [ENEMY],
        details: { targetUnitId: ENEMY, hitIndex: 2 },
      }),
      event({
        sequence: 11,
        type: "DAMAGE_REDIRECTED",
        skillUseId: MAIN,
        parentSequence: 10,
        details: { originalTargetUnitId: ENEMY, newTargetUnitId: ENEMY_2, hitIndex: 2 },
      }),
      event({
        sequence: 12,
        type: "DAMAGE_APPLIED",
        skillUseId: MAIN,
        parentSequence: 10,
        sourceUnitId: ALLY,
        targetUnitIds: [ENEMY_2],
        details: { targetUnitId: ENEMY_2, hitIndex: 2, hitPointDamage: 50 },
      }),
      // DAMAGE_APPLIEDの無い（無効化された）ヒットは数えない
      ...hitOn(13, ENEMY, 3, undefined),
      event({ sequence: 15, type: "EFFECT_ACTION_COMPLETED", skillUseId: MAIN, parentSequence: 3 }),
      event({
        sequence: 16,
        type: "HEAL_APPLIED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY_2],
        details: { targetUnitId: ALLY_2, appliedAmount: 120 },
      }),
      event({
        sequence: 17,
        type: "HEAL_APPLIED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY],
        details: { targetUnitId: ALLY, appliedAmount: 0, discardedAmount: 80 },
      }),
    ];
    const view = board(events, state(), state());
    expect(cardOf(view.units, ENEMY).damage).toEqual({
      total: 650,
      hits: 2,
      critical: true,
      shieldAbsorbed: 150,
    });
    expect(cardOf(view.units, ENEMY_2).damage).toEqual({
      total: 50,
      hits: 1,
      critical: false,
      shieldAbsorbed: 0,
    });
    expect(cardOf(view.units, ALLY_2).heal).toEqual({ total: 120 });
    // 満タンで0回復でも回復を受けたことは示す
    expect(cardOf(view.units, ALLY).heal).toEqual({ total: 0 });
    expect(cardOf(view.units, ALLY).damage).toBeUndefined();

    // 処理単位では現在のステップのヒットだけを数える
    const single = board(events, state(), state(), { stepIndex: 4 });
    expect(cardOf(single.units, ENEMY).damage).toEqual({
      total: 220,
      hits: 1,
      critical: true,
      shieldAbsorbed: 20,
    });
  });

  it("UI-UT-ATR-030: 効果・マーカー・チャージの印が範囲の前後で付いた・続いている・外れたを区別し、分類・残り時間・次点を持つ", () => {
    const kept = {
      effectInstanceId: "E1",
      effectDefinitionId: "EFF_ATTACK_UP",
      category: "BUFF",
      isEffective: true,
      duration: { unit: "TURN", remaining: 2 },
    };
    const before = state({
      [ALLY]: {
        effects: [
          kept,
          {
            effectInstanceId: "E2",
            effectDefinitionId: "EFF_POISON",
            category: "STATUS_ABNORMALITY",
            isEffective: true,
          },
        ],
        markers: [
          { markerInstanceId: "M1", markerId: "MARKER_OLD", stackCount: 1, stackMax: null },
        ],
      },
    });
    const after = state({
      [ALLY]: {
        effects: [
          { ...kept, duration: { unit: "TURN", remaining: 1 } },
          {
            effectInstanceId: "E3",
            effectDefinitionId: "EFF_DEFENSE_DOWN",
            category: "DEBUFF",
            isEffective: false,
            duration: { unit: "ACTION", remaining: 3 },
          },
          {
            effectInstanceId: "E4",
            effectDefinitionId: "EFF_GUARD",
            category: "BUFF",
            isEffective: true,
            duration: { unit: "SKILL_USE", remaining: 2 },
          },
        ],
        markers: [{ markerInstanceId: "M2", markerId: "MARKER_SCAR", stackCount: 3, stackMax: 5 }],
        charge: { skillDefinitionId: "SKL_CHARGE" },
      },
    });
    const chips = cardOf(board(actionStart(), before, after).units, ALLY).chips;
    expect(chips).toEqual([
      {
        key: "effect:E1",
        label: "EFF_ATTACK_UP",
        kind: "BUFF",
        change: "kept",
        remaining: "1T",
        ineffective: false,
      },
      {
        key: "effect:E3",
        label: "EFF_DEFENSE_DOWN",
        kind: "DEBUFF",
        change: "added",
        remaining: "3行動",
        ineffective: true,
      },
      {
        key: "effect:E4",
        label: "EFF_GUARD",
        kind: "BUFF",
        change: "added",
        remaining: "2回",
        ineffective: false,
      },
      {
        key: "marker:M2",
        label: "MARKER_SCAR",
        kind: "MARKER",
        change: "added",
        remaining: "×3",
        ineffective: false,
      },
      { key: "charge", label: "SKL_CHARGE", kind: "CHARGE", change: "added", ineffective: false },
      {
        key: "effect:E2",
        label: "EFF_POISON",
        kind: "STATUS_ABNORMALITY",
        change: "removed",
        ineffective: false,
      },
      {
        key: "marker:M1",
        label: "MARKER_OLD",
        kind: "MARKER",
        change: "removed",
        remaining: "×1",
        ineffective: false,
      },
    ]);
  });

  it("UI-UT-ATR-031: 行動者・PS発動者・対象の役割と撃破を範囲から決める", () => {
    const events = [
      ...actionStart(),
      ...hitOn(4, ENEMY, 0, { hitPointDamage: 1000, defeated: true }),
      event({
        sequence: 7,
        type: "UNIT_DEFEATED",
        parentSequence: 6,
        targetUnitIds: [ENEMY],
        details: { battleUnitId: ENEMY },
      }),
      event({
        sequence: 8,
        type: "PASSIVE_ACTIVATED",
        skillUseId: PS,
        parentSequence: 7,
        sourceUnitId: ENEMY_2,
        details: { skillDefinitionId: "SKL_PS" },
      }),
      event({
        sequence: 9,
        type: "EFFECT_APPLIED",
        skillUseId: PS,
        parentSequence: 8,
        sourceUnitId: ENEMY_2,
        targetUnitIds: [ALLY],
        details: { targetUnitId: ALLY },
      }),
      event({ sequence: 10, type: "ACTION_COMPLETED", parentSequence: 1, sourceUnitId: ALLY }),
    ];
    const before = state();
    const after = state({ [ENEMY]: { hp: 0, combatStatus: "DEFEATED" } });
    const view = board(events, before, after);
    expect(cardOf(view.units, ALLY).roles).toEqual({
      actor: true,
      activator: false,
      target: false,
    });
    expect(cardOf(view.units, ENEMY).roles).toEqual({
      actor: false,
      activator: false,
      target: true,
    });
    expect(cardOf(view.units, ENEMY).defeated).toBe(true);
    expect(cardOf(view.units, ENEMY_2).roles).toEqual({
      actor: false,
      activator: true,
      target: false,
    });
    expect(cardOf(view.units, ALLY_2).roles).toEqual({
      actor: false,
      activator: false,
      target: false,
    });

    // 処理単位のPS発動のステップでは、発動者が「PS発動」、範囲外の対象は対象にならない
    const steps = projectTraceSteps(segmentOf(events), ROSTER);
    const activation = steps.findIndex((s) => s.kind === "ACTIVATION");
    const single = board(events, before, after, { stepIndex: activation });
    expect(cardOf(single.units, ENEMY_2).roles.activator).toBe(true);
    expect(cardOf(single.units, ENEMY).roles.target).toBe(false);
    // 行動者は区間の間ずっと行動者として示す
    expect(cardOf(single.units, ALLY).roles.actor).toBe(true);
  });

  it("UI-UT-ATR-032: 矢印が発動者から対象へ、攻撃は陣営、PSは割り込み、回復は回復として引かれ、自分自身・メモリー・重複には引かない", () => {
    const events = [
      ...actionStart(),
      ...hitOn(4, ENEMY, 0, { hitPointDamage: 10 }),
      ...hitOn(7, ENEMY, 1, { hitPointDamage: 10 }),
      event({
        sequence: 10,
        type: "PASSIVE_ACTIVATED",
        skillUseId: PS,
        parentSequence: 9,
        sourceUnitId: ENEMY,
        details: { skillDefinitionId: "SKL_PS" },
      }),
      ...hitOn(11, ALLY, 0, { hitPointDamage: 5 }, { source: ENEMY, skillUseId: PS }),
      event({
        sequence: 14,
        type: "HEAL_APPLIED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY_2],
        details: { targetUnitId: ALLY_2, appliedAmount: 10 },
      }),
      event({
        sequence: 15,
        type: "HEAL_APPLIED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY],
        details: { targetUnitId: ALLY, appliedAmount: 10 },
      }),
      event({
        sequence: 16,
        type: "MEMORY_TRIGGERED",
        skillUseId: "B:skill-use:memory",
        parentSequence: 3,
        details: { memoryDefinitionId: "MEM_X" },
      }),
      event({
        sequence: 17,
        type: "EFFECT_APPLIED",
        skillUseId: "B:skill-use:memory",
        parentSequence: 16,
        targetUnitIds: [ALLY_2],
        details: { targetUnitId: ALLY_2 },
      }),
    ];
    const view = board(events, state(), state());
    expect(view.arrows).toEqual([
      { fromUnitId: ALLY, toUnitId: ENEMY, kind: "attack", side: "ALLY" },
      { fromUnitId: ENEMY, toUnitId: ALLY, kind: "passive", side: "ENEMY" },
      { fromUnitId: ALLY, toUnitId: ALLY_2, kind: "heal", side: "ALLY" },
    ]);
  });

  it("UI-UT-ATR-033: そのターンの行動区間から、ユニットごとの最初の行動順を求める", () => {
    const fixture = totalWarSuccessFixture as unknown as {
      events: readonly BattleLogEventResponse[];
      unitRoster: readonly RosterEntry[];
    };
    const segments = projectActionSegments(fixture.events, fixture.unitRoster);
    const firstTurn = segments.find((s) => s.kind === "ACTION")!.turnNumber;
    const orders = selectActionOrders(segments, firstTurn);
    const expected = new Map<string, number>();
    for (const s of segments) {
      if (
        s.kind === "ACTION" &&
        s.turnNumber === firstTurn &&
        s.actorUnitId !== undefined &&
        !expected.has(s.actorUnitId)
      ) {
        expected.set(s.actorUnitId, s.actionOrderInTurn);
      }
    }
    expect(expected.size).toBeGreaterThan(0);
    expect(orders).toEqual(expected);
    expect(selectActionOrders(segments, 999).size).toBe(0);
  });
});

describe("projectTraceBoard with a replayed total war", () => {
  it("UI-UT-ATR-034: 途中から出撃したユニットは出撃前の版の盤面に無く、出撃後の版の盤面に出る", () => {
    const fixture = totalWarSuccessFixture as unknown as {
      initialState: BattleStateResponse;
      stateTransitions: readonly Record<string, unknown>[];
      events: readonly BattleLogEventResponse[];
      unitRoster: readonly RosterEntry[];
    };
    const roster = buildRosterIndex(
      fixture.unitRoster.map((entry) => ({ ...entry, displayName: `表示-${entry.battleUnitId}` })),
    );
    const segments = projectActionSegments(fixture.events, fixture.unitRoster);
    const replay = createBattleStateReplay(
      fixture.initialState,
      fixture.stateTransitions,
      segments.map((s) => s.stateVersionBefore),
    );
    const deployed = segments.find(
      (s) => s.kind === "SYSTEM" && s.headline.kind === "FORMATION_DEPLOYED",
    )!;
    const initialIds = new Set(fixture.initialState.units.map((u) => u.battleUnitId));
    const viewAt = (version: number) =>
      projectTraceBoard({
        before: replay.stateAt(version),
        after: replay.stateAt(version),
        segment: deployed,
        steps: [],
        roster,
        actionOrders: new Map(),
      });
    const beforeIds = viewAt(deployed.stateVersionBefore).units.map((u) => u.battleUnitId);
    const after = viewAt(deployed.stateVersionAfter).units;
    const newcomers = after.filter((u) => !initialIds.has(u.battleUnitId));
    expect(newcomers.length).toBeGreaterThan(0);
    for (const card of newcomers) {
      expect(beforeIds).not.toContain(card.battleUnitId);
      expect(card.displayName).toBe(roster.get(card.battleUnitId)?.displayName);
    }
  });
});
