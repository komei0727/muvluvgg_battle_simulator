import { describe, expect, it } from "vitest";
import m4DuplicateDefinitionFixture from "../../test/fixtures/m4-success-duplicate-definition.json";
import m4MinimalFixture from "../../test/fixtures/m4-success-minimal.json";
import malformedSuccessFixture from "../../test/fixtures/malformed-success.json";
import unknownEventFixture from "../../test/fixtures/success-unknown-event.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";
import {
  projectActionSegments,
  type ActionSegment,
  type SegmentSideSource,
} from "./action-segment-projector.js";

interface SegmentFixture {
  readonly events: readonly BattleLogEventResponse[];
  readonly initialState: { readonly units: readonly SegmentSideSource[] };
  readonly unitRoster?: readonly SegmentSideSource[];
}

const FIXTURES: Readonly<Record<string, SegmentFixture>> = {
  "m4-success-minimal": m4MinimalFixture,
  "m4-success-duplicate-definition": m4DuplicateDefinitionFixture,
  "malformed-success": malformedSuccessFixture,
  "success-unknown-event": unknownEventFixture,
  "total-war-success": totalWarSuccessFixture,
};

function rosterOf(fixture: SegmentFixture): readonly SegmentSideSource[] {
  return fixture.unitRoster ?? fixture.initialState.units;
}

const ALLY = "ally:1";
const ALLY_2 = "ally:2";
const ENEMY = "enemy:1";
const ROSTER: readonly SegmentSideSource[] = [
  { battleUnitId: ALLY, side: "ALLY" },
  { battleUnitId: ALLY_2, side: "ALLY" },
  { battleUnitId: ENEMY, side: "ENEMY" },
];

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber?: number;
  readonly actionId?: string;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly sourceUnitId?: string;
  readonly stateVersionBefore?: number;
  readonly stateVersionAfter?: number;
  readonly details?: Record<string, unknown>;
}

function event(seed: EventSeed): BattleLogEventResponse {
  return {
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber ?? 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: [],
    stateVersionBefore: seed.stateVersionBefore ?? seed.sequence,
    stateVersionAfter: seed.stateVersionAfter ?? seed.sequence,
    ...(seed.actionId !== undefined ? { actionId: seed.actionId } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    details: seed.details ?? {},
  };
}

function sequencesOf(segment: ActionSegment): readonly number[] {
  return segment.events.map((e) => Number(e["sequence"]));
}

function expectPartition(
  events: readonly BattleLogEventResponse[],
  segments: readonly ActionSegment[],
): void {
  const all = segments.flatMap(sequencesOf);
  expect([...all].sort((a, b) => a - b)).toEqual(
    events.map((e) => Number(e["sequence"])).sort((a, b) => a - b),
  );
  expect(new Set(all).size).toBe(all.length);
  for (const [index, segment] of segments.entries()) {
    expect(segment.firstSequence).toBe(Math.min(...sequencesOf(segment)));
    expect(segment.lastSequence).toBe(Math.max(...sequencesOf(segment)));
    if (index > 0) {
      expect(segment.firstSequence).toBeGreaterThan(segments[index - 1]!.lastSequence);
    }
  }
}

/**
 * 行動中に敵のPSが割り込み、そのPSを契機に味方のPSが連鎖する1行動。本番Catalogでは
 * 割り込みPSも行動と同じ`actionId`を持つ（実測）ため、ここでもそう組む。
 */
function interruptedActionEvents(): readonly BattleLogEventResponse[] {
  const actionId = "B:action:1";
  return [
    event({ sequence: 1, type: "TURN_STARTED", stateVersionBefore: 0, stateVersionAfter: 1 }),
    event({ sequence: 2, type: "ACTION_QUEUE_CREATED", parentSequence: 1 }),
    event({
      sequence: 3,
      type: "ACTION_STARTED",
      actionId,
      sourceUnitId: ALLY,
      details: { actorUnitId: ALLY },
    }),
    // 「攻撃する前」PSが行動本体より先に解決する。行動本体のスキルはこれを飛ばして決まる。
    event({
      sequence: 4,
      type: "PASSIVE_ACTIVATED",
      actionId,
      skillUseId: "B:skill-use:pre",
      parentSequence: 3,
      sourceUnitId: ALLY,
      details: { skillDefinitionId: "SKL_PRE_PS" },
    }),
    event({
      sequence: 5,
      type: "TARGETS_SELECTED",
      actionId,
      skillUseId: "B:skill-use:as",
      parentSequence: 3,
      sourceUnitId: ALLY,
      details: { skillDefinitionId: "SKL_MAIN_AS" },
    }),
    event({
      sequence: 6,
      type: "SKILL_USE_STARTED",
      actionId,
      skillUseId: "B:skill-use:as",
      parentSequence: 5,
      sourceUnitId: ALLY,
    }),
    event({
      sequence: 7,
      type: "PASSIVE_ACTIVATED",
      actionId,
      skillUseId: "B:skill-use:enemy-ps",
      parentSequence: 6,
      sourceUnitId: ENEMY,
      details: { skillDefinitionId: "SKL_ENEMY_PS" },
    }),
    event({
      sequence: 8,
      type: "PASSIVE_ACTIVATED",
      actionId,
      skillUseId: "B:skill-use:ally-chain",
      parentSequence: 7,
      sourceUnitId: ALLY_2,
      details: { skillDefinitionId: "SKL_ALLY_CHAIN_PS" },
    }),
    event({
      sequence: 9,
      type: "UNIT_DEFEATED",
      actionId,
      skillUseId: "B:skill-use:as",
      parentSequence: 6,
      sourceUnitId: ALLY,
      stateVersionBefore: 9,
      stateVersionAfter: 12,
    }),
    event({ sequence: 10, type: "ACTION_COMPLETED", actionId, parentSequence: 3 }),
    // `actionId`を持たないが祖先が行動区間に属する（孫まで辿る）。
    event({ sequence: 11, type: "ACTION_RESERVATION_REMOVED", parentSequence: 10 }),
    event({ sequence: 12, type: "ACTION_QUEUE_REORDERED", parentSequence: 11 }),
    event({ sequence: 13, type: "TURN_COMPLETING" }),
    event({ sequence: 14, type: "TURN_COMPLETED", parentSequence: 13 }),
  ];
}

describe("projectActionSegments partitions every event (UI-UT-ATR-006)", () => {
  it.each(Object.entries(FIXTURES))(
    "%s: every event belongs to exactly one segment",
    (_, fixture) => {
      const segments = projectActionSegments(fixture.events, rosterOf(fixture));
      expect(segments.length).toBeGreaterThan(0);
      expectPartition(fixture.events, segments);
    },
  );

  it("partitions a battle with interrupting and turn-start PS without overlap", () => {
    const events = interruptedActionEvents();
    expectPartition(events, projectActionSegments(events, ROSTER));
  });

  it("sorts events by sequence before partitioning and does not mutate the input", () => {
    const events = interruptedActionEvents();
    const shuffled = [...events].reverse();
    const snapshot = JSON.stringify(shuffled);
    const segments = projectActionSegments(shuffled, ROSTER);
    expect(JSON.stringify(shuffled)).toBe(snapshot);
    expect(segments.map(sequencesOf)).toEqual(
      projectActionSegments(events, ROSTER).map(sequencesOf),
    );
  });

  it("returns no segment for an empty event list", () => {
    expect(projectActionSegments([], ROSTER)).toEqual([]);
  });
});

describe("projectActionSegments resolves action segments (UI-UT-ATR-007)", () => {
  it("groups events sharing an actionId, keeping interrupting PS inside the action", () => {
    const segments = projectActionSegments(interruptedActionEvents(), ROSTER);
    const action = segments[1]!;
    expect(action.kind).toBe("ACTION");
    if (action.kind !== "ACTION") return;
    expect(sequencesOf(action)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(action.actionId).toBe("B:action:1");
    expect(action.actorUnitId).toBe(ALLY);
    expect(action.side).toBe("ALLY");
    // 先に解決した「攻撃する前」PS・割り込みPSは行動本体ではない。
    expect(action.mainSkill).toEqual({
      skillUseId: "B:skill-use:as",
      skillDefinitionId: "SKL_MAIN_AS",
    });
    expect(action.actionOrderInTurn).toBe(1);
    expect(action.turnNumber).toBe(1);
    expect(action.containsDefeat).toBe(true);
    expect(action.stateVersionBefore).toBe(3);
    expect(action.stateVersionAfter).toBe(12);
  });

  it("resolves the actor from the first sourceUnitId when ACTION_STARTED is absent", () => {
    const segments = projectActionSegments(
      [
        event({ sequence: 1, type: "RESOURCE_CHANGED", actionId: "A" }),
        event({ sequence: 2, type: "TARGETS_SELECTED", actionId: "A", sourceUnitId: ENEMY }),
      ],
      ROSTER,
    );
    const action = segments[0]!;
    expect(action.kind).toBe("ACTION");
    if (action.kind !== "ACTION") return;
    expect(action.actorUnitId).toBe(ENEMY);
    expect(action.side).toBe("ENEMY");
    expect(action.mainSkill).toBeUndefined();
  });

  it("leaves the side unresolved for an actor missing from the roster", () => {
    const segments = projectActionSegments(
      [
        event({
          sequence: 1,
          type: "ACTION_STARTED",
          actionId: "A",
          details: { actorUnitId: "x" },
        }),
      ],
      ROSTER,
    );
    const action = segments[0]!;
    expect(action.kind === "ACTION" && action.side).toBeUndefined();
  });

  it("numbers actions within each turn and restarts the count on the next turn", () => {
    const fixture = FIXTURES["total-war-success"]!;
    const actions = projectActionSegments(fixture.events, rosterOf(fixture)).filter(
      (segment) => segment.kind === "ACTION",
    );
    expect(actions.map((a) => [a.turnNumber, a.actionOrderInTurn, a.actorUnitId])).toEqual([
      [1, 1, "ally:1"],
      [2, 1, "ally:1"],
    ]);
    expect(actions.map((a) => a.mainSkill?.skillDefinitionId)).toEqual([
      "SKL_UI_FIXTURE_STRIKE",
      expect.any(String),
    ]);
  });
});

describe("projectActionSegments attaches orphan descendants (UI-UT-ATR-008)", () => {
  it("puts ACTION_RESERVATION_REMOVED of the minimal fixture into the action segment", () => {
    const fixture = FIXTURES["m4-success-minimal"]!;
    const segments = projectActionSegments(fixture.events, rosterOf(fixture));
    const action = segments.find((segment) => segment.kind === "ACTION")!;
    expect(action.firstSequence).toBe(9);
    expect(action.lastSequence).toBe(30);
    expect(action.events.at(-1)!["type"]).toBe("ACTION_RESERVATION_REMOVED");
  });

  it("follows parentSequence through several orphan generations", () => {
    const segments = projectActionSegments(interruptedActionEvents(), ROSTER);
    expect(segments[1]!.lastSequence).toBe(12);
    expect(segments[2]!.firstSequence).toBe(13);
  });

  it("does not attach an orphan whose ancestor is in a system segment", () => {
    const segments = projectActionSegments(
      [
        event({ sequence: 1, type: "TURN_STARTED" }),
        event({ sequence: 2, type: "PASSIVE_ACTIVATED", skillUseId: "ps", parentSequence: 1 }),
        event({ sequence: 3, type: "EFFECT_APPLIED", skillUseId: "ps", parentSequence: 2 }),
      ],
      ROSTER,
    );
    expect(segments.map((segment) => [segment.kind, ...sequencesOf(segment)])).toEqual([
      ["SYSTEM", 1, 2, 3],
    ]);
  });
});

describe("projectActionSegments builds system segments (UI-UT-ATR-009)", () => {
  it("splits the minimal fixture into battle start, turn start, action, and battle end", () => {
    const fixture = FIXTURES["m4-success-minimal"]!;
    const segments = projectActionSegments(fixture.events, rosterOf(fixture));
    expect(
      segments.map((segment) => [
        segment.kind,
        segment.firstSequence,
        segment.lastSequence,
        segment.turnNumber,
        segment.kind === "SYSTEM" ? segment.headline : segment.actionId,
      ]),
    ).toEqual([
      ["SYSTEM", 1, 1, 0, { kind: "BATTLE_STARTED" }],
      ["SYSTEM", 2, 8, 1, { kind: "TURN_STARTED", turnNumber: 1 }],
      ["ACTION", 9, 30, 1, "B_UI_FIXTURE_MINIMAL:action:1"],
      ["SYSTEM", 31, 31, 1, { kind: "BATTLE_COMPLETED" }],
    ]);
    expect(segments[0]!.stateVersionBefore).toBe(0);
    expect(segments[0]!.stateVersionAfter).toBe(1);
    expect(segments[1]!.containsDefeat).toBe(false);
  });

  it("keeps turn-start PS inside the system segment", () => {
    const segments = projectActionSegments(interruptedActionEvents(), ROSTER);
    expect(segments[0]).toMatchObject({
      kind: "SYSTEM",
      headline: { kind: "TURN_STARTED", turnNumber: 1 },
    });
    expect(sequencesOf(segments[0]!)).toEqual([1, 2]);
    expect(segments[2]).toMatchObject({
      kind: "SYSTEM",
      headline: { kind: "TURN_COMPLETED", turnNumber: 1 },
    });
  });

  it("uses TURN_COMPLETING and the generic heading when no known type is present", () => {
    const segments = projectActionSegments(
      [
        event({ sequence: 1, type: "TURN_COMPLETING", turnNumber: 3 }),
        event({ sequence: 2, type: "ACTION", actionId: "A" }),
        event({ sequence: 3, type: "RESOURCE_CHANGED", turnNumber: 3 }),
      ],
      ROSTER,
    );
    expect(segments[0]).toMatchObject({ headline: { kind: "TURN_COMPLETED", turnNumber: 3 } });
    expect(segments[2]).toMatchObject({ kind: "SYSTEM", headline: { kind: "OTHER" } });
  });

  it("splits system events separated by an action into two segments", () => {
    const segments = projectActionSegments(
      [
        event({ sequence: 1, type: "RESOURCE_CHANGED" }),
        event({ sequence: 2, type: "ACTION_STARTED", actionId: "A" }),
        event({ sequence: 3, type: "RESOURCE_CHANGED" }),
      ],
      ROSTER,
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["SYSTEM", "ACTION", "SYSTEM"]);
  });
});

describe("projectActionSegments splits system segments at turn boundaries (UI-UT-ATR-022)", () => {
  it("separates turn 1 completion from turn 2 deployment and start in total war", () => {
    const fixture = FIXTURES["total-war-success"]!;
    const segments = projectActionSegments(fixture.events, rosterOf(fixture));
    expect(
      segments.map((segment) => [
        segment.kind,
        segment.firstSequence,
        segment.lastSequence,
        segment.turnNumber,
        segment.kind === "SYSTEM" ? segment.headline : segment.actionId,
      ]),
    ).toEqual([
      ["SYSTEM", 1, 1, 0, { kind: "BATTLE_STARTED" }],
      ["SYSTEM", 2, 8, 1, { kind: "TURN_STARTED", turnNumber: 1 }],
      // 編成の全滅（FORMATION_DEFEATED）は撃破した行動を親に持つため行動区間へ入る。
      ["ACTION", 9, 31, 1, "B_UI_FIXTURE_TOTAL_WAR:action:1"],
      ["SYSTEM", 32, 33, 1, { kind: "TURN_COMPLETED", turnNumber: 1 }],
      ["SYSTEM", 34, 40, 2, { kind: "FORMATION_DEPLOYED", side: "ENEMY", formationNumber: 2 }],
      ["ACTION", 41, 63, 2, "B_UI_FIXTURE_TOTAL_WAR:action:2"],
      ["SYSTEM", 64, 64, 2, { kind: "BATTLE_COMPLETED" }],
    ]);
  });

  it("omits deployment details that are not in the expected shape", () => {
    const segments = projectActionSegments(
      [event({ sequence: 1, type: "FORMATION_DEPLOYED", details: { side: 1 } })],
      ROSTER,
    );
    expect(segments[0]).toMatchObject({ headline: { kind: "FORMATION_DEPLOYED" } });
    expect(segments[0]!.kind === "SYSTEM" && segments[0]!.headline).toEqual({
      kind: "FORMATION_DEPLOYED",
    });
  });
});
