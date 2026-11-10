import { describe, expect, it } from "vitest";
import m4DuplicateDefinitionFixture from "../../test/fixtures/m4-success-duplicate-definition.json";
import m4MinimalFixture from "../../test/fixtures/m4-success-minimal.json";
import malformedSuccessFixture from "../../test/fixtures/malformed-success.json";
import unknownEventFixture from "../../test/fixtures/success-unknown-event.json";
import totalWarSuccessFixture from "../../test/fixtures/total-war-success.json";
import { buildRosterIndex, formatEvent } from "../details/event-formatters.js";
import type { RosterEntry } from "../../entities/roster.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";
import {
  projectActionSegments,
  type ActionSegment,
  type SegmentSideSource,
} from "./action-segment-projector.js";
import { projectTraceSteps, type TraceStep } from "./trace-step-projector.js";

interface StepFixture {
  readonly events: readonly BattleLogEventResponse[];
  readonly initialState: { readonly units: readonly SegmentSideSource[] };
  readonly unitRoster?: readonly SegmentSideSource[];
}

const FIXTURES: Readonly<Record<string, StepFixture>> = {
  "m4-success-minimal": m4MinimalFixture,
  "m4-success-duplicate-definition": m4DuplicateDefinitionFixture,
  "malformed-success": malformedSuccessFixture,
  "success-unknown-event": unknownEventFixture,
  "total-war-success": totalWarSuccessFixture,
};

const ALLY = "ally:1";
const ALLY_2 = "ally:2";
const ENEMY = "enemy:1";
const ENEMY_2 = "enemy:2";
const ROSTER_ENTRIES: readonly RosterEntry[] = [
  { battleUnitId: ALLY, unitDefinitionId: "UNIT_A", side: "ALLY", displayName: "味方A" },
  { battleUnitId: ALLY_2, unitDefinitionId: "UNIT_B", side: "ALLY", displayName: "味方B" },
  { battleUnitId: ENEMY, unitDefinitionId: "UNIT_C", side: "ENEMY", displayName: "敵C" },
  { battleUnitId: ENEMY_2, unitDefinitionId: "UNIT_D", side: "ENEMY", displayName: "敵D" },
];
const ROSTER = buildRosterIndex(ROSTER_ENTRIES);

const ACTION_ID = "B:action:1";
const MAIN = "B:skill-use:as";

interface EventSeed {
  readonly sequence: number;
  readonly type: string;
  readonly turnNumber?: number;
  readonly actionId?: string | null;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly sourceUnitId?: string;
  readonly targetUnitIds?: readonly string[];
  readonly stateVersionBefore?: number;
  readonly stateVersionAfter?: number;
  readonly details?: Record<string, unknown>;
}

/** `actionId`を省くと行動IDを付ける。`null`でシステム区間のイベントにする。 */
function event(seed: EventSeed): BattleLogEventResponse {
  const actionId = seed.actionId === undefined ? ACTION_ID : seed.actionId;
  return {
    sequence: seed.sequence,
    type: seed.type,
    category: "FACT",
    turnNumber: seed.turnNumber ?? 1,
    cycleNumber: 1,
    rootSequence: 1,
    targetUnitIds: seed.targetUnitIds ?? [],
    stateVersionBefore: seed.stateVersionBefore ?? seed.sequence,
    stateVersionAfter: seed.stateVersionAfter ?? seed.sequence,
    ...(actionId !== null ? { actionId } : {}),
    ...(seed.skillUseId !== undefined ? { skillUseId: seed.skillUseId } : {}),
    ...(seed.parentSequence !== undefined ? { parentSequence: seed.parentSequence } : {}),
    ...(seed.sourceUnitId !== undefined ? { sourceUnitId: seed.sourceUnitId } : {}),
    details: seed.details ?? {},
  };
}

function onlySegment(events: readonly BattleLogEventResponse[]): ActionSegment {
  const segments = projectActionSegments(events, ROSTER_ENTRIES);
  expect(segments).toHaveLength(1);
  return segments[0]!;
}

function stepsOf(events: readonly BattleLogEventResponse[]): readonly TraceStep[] {
  return projectTraceSteps(onlySegment(events), ROSTER);
}

function sequencesOf(step: TraceStep): readonly number[] {
  return step.events.map((e) => Number(e["sequence"]));
}

function shapeOf(steps: readonly TraceStep[]): readonly [string, readonly number[]][] {
  return steps.map((step) => [step.kind, sequencesOf(step)]);
}

/** 行動開始・対象選択・スキル使用の後に`body`が続く1行動。 */
function actionWith(body: readonly BattleLogEventResponse[]): readonly BattleLogEventResponse[] {
  return [
    event({
      sequence: 1,
      type: "ACTION_STARTED",
      sourceUnitId: ALLY,
      details: { actorUnitId: ALLY },
    }),
    event({
      sequence: 2,
      type: "TARGETS_SELECTED",
      skillUseId: MAIN,
      parentSequence: 1,
      sourceUnitId: ALLY,
    }),
    event({ sequence: 3, type: "SKILL_USE_STARTED", skillUseId: MAIN, parentSequence: 2 }),
    ...body,
  ];
}

function hit(
  sequence: number,
  targetUnitId: string,
  hitIndex: number,
  type = "HIT_CONFIRMED",
): BattleLogEventResponse {
  return event({
    sequence,
    type,
    skillUseId: MAIN,
    parentSequence: 3,
    sourceUnitId: ALLY,
    targetUnitIds: [targetUnitId],
    details: { targetUnitId, hitIndex },
  });
}

function applied(
  sequence: number,
  targetUnitId: string,
  hitIndex: number,
  details: Record<string, unknown> = {},
): BattleLogEventResponse {
  return event({
    sequence,
    type: "DAMAGE_APPLIED",
    skillUseId: MAIN,
    parentSequence: sequence - 1,
    sourceUnitId: ALLY,
    targetUnitIds: [targetUnitId],
    details: { targetUnitId, hitIndex, ...details },
  });
}

function plain(sequence: number, type: string, parentSequence = 3): BattleLogEventResponse {
  return event({ sequence, type, skillUseId: MAIN, parentSequence });
}

describe("projectTraceSteps partitions every event (UI-UT-ATR-010)", () => {
  it.each(Object.entries(FIXTURES))(
    "%s: every event of every segment belongs to exactly one step",
    (_, fixture) => {
      const roster = fixture.unitRoster ?? fixture.initialState.units;
      for (const segment of projectActionSegments(fixture.events, roster)) {
        const steps = projectTraceSteps(segment, ROSTER);
        const all = steps.flatMap(sequencesOf);
        expect(all).toEqual(segment.events.map((e) => Number(e["sequence"])));
        for (const [index, step] of steps.entries()) {
          expect(step.index).toBe(index);
          expect(step.firstSequence).toBe(sequencesOf(step)[0]);
          expect(step.lastSequence).toBe(sequencesOf(step).at(-1));
        }
      }
    },
  );

  it("attaches unknown event types to the preceding step as others", () => {
    const steps = stepsOf(
      actionWith([
        plain(4, "SOME_FUTURE_EVENT"),
        event({ sequence: 5, type: "ACTION_COMPLETED", parentSequence: 1 }),
      ]),
    );
    expect(shapeOf(steps)).toEqual([
      ["ACTION_STARTED", [1]],
      ["TARGETS_SELECTED", [2]],
      ["SKILL_USE", [3, 4]],
      ["ACTION_COMPLETED", [5]],
    ]);
    expect(steps[2]!.otherEvents.map((e) => e.type)).toEqual(["SOME_FUTURE_EVENT"]);
    expect(steps[2]!.originEvents.map((e) => e.type)).toEqual(["SKILL_USE_STARTED"]);
  });

  it("makes a leading run of non-origin events a single step of its own", () => {
    const steps = stepsOf([
      event({ sequence: 1, type: "SOME_FUTURE_EVENT", sourceUnitId: ALLY }),
      event({ sequence: 2, type: "RESOURCE_CHANGED", parentSequence: 1 }),
      event({ sequence: 3, type: "ACTION_STARTED", details: { actorUnitId: ALLY } }),
    ]);
    expect(shapeOf(steps)).toEqual([
      ["OTHER", [1, 2]],
      ["ACTION_STARTED", [3]],
    ]);
    expect(steps[0]!.originEvents).toEqual([]);
    expect(steps[0]!.presentations).toEqual([formatEvent(steps[0]!.events[0]!, ROSTER)]);
  });

  it("formats each origin event with the shared formatEvent", () => {
    const fixture = FIXTURES["m4-success-minimal"]!;
    const segment = projectActionSegments(fixture.events, fixture.initialState.units).find(
      (s) => s.kind === "ACTION",
    )!;
    for (const step of projectTraceSteps(segment, ROSTER)) {
      expect(step.presentations).toEqual(step.originEvents.map((e) => formatEvent(e, ROSTER)));
    }
  });

  it("returns the source and the union of targets, without a source for a memory", () => {
    const steps = stepsOf([
      event({
        sequence: 1,
        type: "MEMORY_TRIGGERED",
        skillUseId: "B:skill-use:memory",
        details: { memoryDefinitionId: "MEM_X" },
      }),
      event({
        sequence: 2,
        type: "EFFECT_APPLIED",
        skillUseId: "B:skill-use:memory",
        parentSequence: 1,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY],
      }),
      event({
        sequence: 3,
        type: "EFFECT_APPLIED",
        skillUseId: "B:skill-use:memory",
        parentSequence: 1,
        sourceUnitId: ALLY,
        targetUnitIds: [ALLY_2, ALLY],
      }),
    ]);
    expect(steps[0]!.sourceUnitId).toBeUndefined();
    expect(steps[1]!.sourceUnitId).toBe(ALLY);
    expect(steps[1]!.targetUnitIds).toEqual([ALLY, ALLY_2]);
  });
});

describe("projectTraceSteps splits hits and bundles effects (UI-UT-ATR-011)", () => {
  it("makes one step per target and per hit of a multi-hit skill", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        applied(5, ENEMY, 1),
        hit(6, ENEMY, 2),
        applied(7, ENEMY, 2),
        hit(8, ENEMY_2, 1),
        applied(9, ENEMY_2, 1),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5]],
      ["HIT", [6, 7]],
      ["HIT", [8, 9]],
    ]);
    expect(steps.slice(3).map((step) => [step.hit?.targetUnitId, step.hit?.hitIndex])).toEqual([
      [ENEMY, 1],
      [ENEMY, 2],
      [ENEMY_2, 1],
    ]);
  });

  it("bundles consecutive effects and heals sharing a parent, but not across parents", () => {
    const effect = (sequence: number, type: string, parentSequence: number, target: string) =>
      event({
        sequence,
        type,
        skillUseId: MAIN,
        parentSequence,
        sourceUnitId: ALLY,
        targetUnitIds: [target],
        details: { targetUnitId: target, appliedAmount: 10, hpBefore: 0, hpAfter: 10 },
      });
    const steps = stepsOf(
      actionWith([
        effect(4, "EFFECT_APPLIED", 3, ALLY),
        plain(5, "COMBAT_STAT_CHANGED", 4),
        effect(6, "EFFECT_APPLIED", 3, ALLY_2),
        effect(7, "EFFECT_APPLIED", 6, ALLY),
        effect(8, "HEAL_APPLIED", 3, ALLY),
        effect(9, "HEAL_APPLIED", 3, ALLY_2),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["EFFECT", [4, 5, 6]],
      ["EFFECT", [7]],
      ["HEAL", [8, 9]],
    ]);
    expect(steps[3]!.originEvents.map((e) => e["sequence"])).toEqual([4, 6]);
    expect(steps[3]!.presentations).toHaveLength(2);
    expect(steps[3]!.targetUnitIds).toEqual([ALLY, ALLY_2]);
  });

  it("classifies every origin type of the table", () => {
    const types: readonly [string, string][] = [
      ["CONTINUOUS_DAMAGE_APPLIED", "SPECIAL_DAMAGE"],
      ["REFLECTED_DAMAGE_GENERATED", "SPECIAL_DAMAGE"],
      ["LINKED_DAMAGE_GENERATED", "SPECIAL_DAMAGE"],
      ["HEALING_TRANSFERRED", "HEAL"],
      ["EFFECT_REMOVED", "EFFECT"],
      ["MARKER_APPLIED", "EFFECT"],
      ["MARKER_REMOVED", "EFFECT"],
      ["CHARGE_STARTED", "CHARGE"],
      ["CHARGE_RELEASED", "CHARGE"],
      ["CHARGE_CANCELLED", "CHARGE"],
      ["UNIT_DEFEATED", "DEFEAT"],
      ["LETHAL_DAMAGE_SURVIVED", "DEFEAT"],
      ["UNIT_BROKEN", "DEFEAT"],
      ["UNIT_REVIVED", "DEFEAT"],
      ["RESOURCES_RECOVERED", "SYSTEM"],
      ["FORMATION_DEFEATED", "SYSTEM"],
    ];
    const steps = stepsOf(
      actionWith(types.map(([type], index) => plain(4 + index, type, 1 + index))),
    );
    expect(steps.slice(3).map((step) => [step.originEvents[0]!.type, step.kind])).toEqual(types);
  });
});

/**
 * 行動中に敵のPSが割り込み、そのPSを契機に味方のPSが連鎖する1行動
 * （`action-segment-projector.test.ts`と同じ組み方）。
 */
function interruptedEvents(): readonly BattleLogEventResponse[] {
  return [
    event({ sequence: 1, type: "ACTION_STARTED", details: { actorUnitId: ALLY } }),
    event({
      sequence: 2,
      type: "PASSIVE_ACTIVATED",
      skillUseId: "B:skill-use:pre",
      parentSequence: 1,
      sourceUnitId: ALLY,
    }),
    event({ sequence: 3, type: "TARGETS_SELECTED", skillUseId: MAIN, parentSequence: 1 }),
    event({ sequence: 4, type: "SKILL_USE_STARTED", skillUseId: MAIN, parentSequence: 3 }),
    hit(5, ENEMY, 1),
    applied(6, ENEMY, 1),
    event({
      sequence: 7,
      type: "PASSIVE_ACTIVATED",
      skillUseId: "B:skill-use:enemy-ps",
      parentSequence: 6,
      sourceUnitId: ENEMY,
    }),
    event({
      sequence: 8,
      type: "EFFECT_APPLIED",
      skillUseId: "B:skill-use:enemy-ps",
      parentSequence: 7,
      sourceUnitId: ENEMY,
      targetUnitIds: [ENEMY],
    }),
    event({
      sequence: 9,
      type: "PASSIVE_ACTIVATED",
      skillUseId: "B:skill-use:ally-chain",
      parentSequence: 8,
      sourceUnitId: ALLY_2,
    }),
    event({
      sequence: 10,
      type: "HEAL_APPLIED",
      skillUseId: "B:skill-use:ally-chain",
      parentSequence: 9,
      sourceUnitId: ALLY_2,
    }),
    event({
      sequence: 11,
      type: "PASSIVE_ACTIVATED",
      skillUseId: "B:skill-use:third",
      parentSequence: 10,
      sourceUnitId: ENEMY_2,
    }),
    event({ sequence: 12, type: "UNIT_DEFEATED", skillUseId: MAIN, parentSequence: 6 }),
    event({ sequence: 13, type: "ACTION_COMPLETED", parentSequence: 1 }),
  ];
}

describe("projectTraceSteps resolves interrupt depth (UI-UT-ATR-012)", () => {
  it("nests chained PS by their parentSequence and keeps the main skill at depth 0", () => {
    const steps = stepsOf(interruptedEvents());
    expect(steps.map((step) => [sequencesOf(step)[0], step.interruptDepth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 0],
      [5, 0],
      [7, 1],
      [8, 1],
      [9, 2],
      [10, 2],
      [11, 3],
      [12, 0],
      [13, 0],
    ]);
    expect(steps[5]!.skillUseId).toBe("B:skill-use:enemy-ps");
  });

  it("does not indent the PS triggered by a system event, only its chain", () => {
    const steps = stepsOf([
      event({ sequence: 1, type: "TURN_STARTED", actionId: null }),
      event({
        sequence: 2,
        type: "PASSIVE_ACTIVATED",
        actionId: null,
        skillUseId: "B:skill-use:turn-ps",
        parentSequence: 1,
        sourceUnitId: ALLY,
      }),
      event({
        sequence: 3,
        type: "EFFECT_APPLIED",
        actionId: null,
        skillUseId: "B:skill-use:turn-ps",
        parentSequence: 2,
      }),
      event({
        sequence: 4,
        type: "PASSIVE_ACTIVATED",
        actionId: null,
        skillUseId: "B:skill-use:chain",
        parentSequence: 3,
        sourceUnitId: ENEMY,
      }),
      event({ sequence: 5, type: "RESOURCES_RECOVERED", actionId: null }),
    ]);
    expect(steps.map((step) => [step.kind, step.interruptDepth])).toEqual([
      ["SYSTEM", 0],
      ["ACTIVATION", 0],
      ["EFFECT", 0],
      ["ACTIVATION", 1],
      ["SYSTEM", 0],
    ]);
  });

  it("takes the skillUseId from the first event that has one when the origin has none", () => {
    const steps = stepsOf([
      event({ sequence: 1, type: "ACTION_STARTED", details: { actorUnitId: ALLY } }),
      event({
        sequence: 2,
        type: "PASSIVE_ACTIVATED",
        skillUseId: "B:skill-use:ps",
        parentSequence: 1,
      }),
      event({ sequence: 3, type: "UNIT_DEFEATED", parentSequence: 2 }),
      event({ sequence: 4, type: "RESOURCE_CHANGED", skillUseId: "B:skill-use:ps" }),
    ]);
    expect(steps[2]!.skillUseId).toBe("B:skill-use:ps");
    expect(steps[2]!.interruptDepth).toBe(1);
  });
});

describe("projectTraceSteps reads hit breakdowns and heal amounts (UI-UT-ATR-013)", () => {
  it("copies DAMAGE_CALCULATED, DAMAGE_APPLIED and the critical check from the payload", () => {
    const fixture = FIXTURES["m4-success-minimal"]!;
    const segment = projectActionSegments(fixture.events, fixture.initialState.units).find(
      (s) => s.kind === "ACTION",
    )!;
    const hitStep = projectTraceSteps(segment, ROSTER).find((step) => step.kind === "HIT")!;
    const calculated = hitStep.events.find((e) => e.type === "DAMAGE_CALCULATED")!;
    const damageApplied = hitStep.events.find((e) => e.type === "DAMAGE_APPLIED")!;
    const calculatedDetails = calculated["details"] as Record<string, unknown>;
    const appliedDetails = damageApplied["details"] as Record<string, unknown>;

    expect(hitStep.hit?.critical).toBe(false);
    expect(hitStep.hit?.calculation).toEqual({
      damageType: calculatedDetails["damageType"],
      attackerAttack: calculatedDetails["attackerAttack"],
      defenderDefense: calculatedDetails["defenderDefense"],
      effectiveDefense: calculatedDetails["effectiveDefense"],
      defenseIgnoreRate: calculatedDetails["defenseIgnoreRate"],
      shieldIgnoreRate: calculatedDetails["shieldIgnoreRate"],
      damageReductionIgnoreRate: calculatedDetails["damageReductionIgnoreRate"],
      baseDamage: calculatedDetails["baseDamage"],
      skillPower: calculatedDetails["skillPower"],
      skillPowerFormulaKind: calculatedDetails["skillPowerFormulaKind"],
      attributeMultiplier: calculatedDetails["attributeMultiplier"],
      attackerAttribute: calculatedDetails["attackerAttribute"],
      defenderAttribute: calculatedDetails["defenderAttribute"],
      isFavorableAttribute: calculatedDetails["isFavorableAttribute"],
      isSubAttributeFavorable: calculatedDetails["isSubAttributeFavorable"],
      attackerAffinityBonus: calculatedDetails["attackerAffinityBonus"],
      criticalMultiplier: calculatedDetails["criticalMultiplier"],
      outgoingDamageMultiplier: calculatedDetails["outgoingDamageMultiplier"],
      incomingDamageMultiplier: calculatedDetails["incomingDamageMultiplier"],
      actionDamageMultiplier: calculatedDetails["actionDamageMultiplier"],
      confusionDamageMultiplier: calculatedDetails["confusionDamageMultiplier"],
      rawPreTruncationDamage: calculatedDetails["rawPreTruncationDamage"],
      freezeMultiplier: calculatedDetails["freezeMultiplier"],
      guardRate: calculatedDetails["guardRate"],
      preTruncationDamage: calculatedDetails["preTruncationDamage"],
      thresholdReductionMultiplier: calculatedDetails["thresholdReductionMultiplier"],
      damageImmunityNullified: calculatedDetails["damageImmunityNullified"],
      finalDamage: calculatedDetails["finalDamage"],
    });
    expect(hitStep.hit?.application).toEqual({
      calculatedDamage: appliedDetails["calculatedDamage"],
      typedShieldAbsorbed: appliedDetails["typedShieldAbsorbed"],
      untypedShieldAbsorbed: appliedDetails["untypedShieldAbsorbed"],
      subUnitAbsorbed: appliedDetails["subUnitAbsorbed"],
      hpDirectDamage: appliedDetails["hpDirectDamage"],
      hitPointDamage: appliedDetails["hitPointDamage"],
      discardedDamage: appliedDetails["discardedDamage"],
      hpBefore: appliedDetails["hpBefore"],
      hpAfter: appliedDetails["hpAfter"],
      defeated: true,
    });
  });

  it("omits items the payload does not carry instead of reporting 0", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        event({
          sequence: 5,
          type: "DAMAGE_CALCULATED",
          skillUseId: MAIN,
          parentSequence: 4,
          details: { finalDamage: 500, attackerAttack: "not-a-number" },
        }),
        applied(6, ENEMY, 1, { hitPointDamage: 500, defeated: false }),
      ]),
    );
    expect(steps[3]!.hit).toEqual({
      targetUnitId: ENEMY,
      hitIndex: 1,
      calculation: { finalDamage: 500 },
      application: { hitPointDamage: 500, defeated: false },
    });
  });

  it("has no breakdown for an evaded hit and no hit for non-hit steps", () => {
    const steps = stepsOf(actionWith([hit(4, ENEMY, 1, "EVASION_ACTIVATED")]));
    expect(steps[3]!.hit).toEqual({ targetUnitId: ENEMY, hitIndex: 1 });
    expect(steps[0]!.hit).toBeUndefined();
  });

  it("returns the applied heal amount and the discarded overflow per target", () => {
    const heal = (sequence: number, details: Record<string, unknown>) =>
      event({
        sequence,
        type: "HEAL_APPLIED",
        skillUseId: MAIN,
        parentSequence: 3,
        sourceUnitId: ALLY,
        details,
      });
    const steps = stepsOf(
      actionWith([
        heal(4, { targetUnitId: ALLY, appliedAmount: 300, discardedAmount: 200 }),
        heal(5, { targetUnitId: ALLY_2, appliedAmount: 120 }),
        heal(6, { targetUnitId: ALLY }),
      ]),
    );
    expect(steps[3]!.heals).toEqual([
      { targetUnitId: ALLY, appliedAmount: 300, discardedAmount: 200 },
      { targetUnitId: ALLY_2, appliedAmount: 120 },
    ]);
    expect(steps[0]!.heals).toBeUndefined();
  });

  it("reads the transferred amount of a healing link with the receiver from toUnitId", () => {
    const steps = stepsOf(
      actionWith([
        event({
          sequence: 4,
          type: "HEALING_TRANSFERRED",
          skillUseId: MAIN,
          parentSequence: 3,
          sourceUnitId: ALLY,
          details: {
            fromUnitId: ALLY,
            toUnitId: ALLY_2,
            appliedAmount: 5452,
            discardedAmount: 0,
            hpBefore: 100,
            hpAfter: 5552,
          },
        }),
      ]),
    );
    expect(steps[3]!.kind).toBe("HEAL");
    expect(steps[3]!.heals).toEqual([
      { targetUnitId: ALLY_2, appliedAmount: 5452, discardedAmount: 0 },
    ]);
  });
});

describe("projectTraceSteps keeps the application of a hit together (UI-UT-ATR-023)", () => {
  it("keeps a shield-exhausting hit in one step with both calculation and HP damage", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        event({
          sequence: 5,
          type: "DAMAGE_CALCULATED",
          skillUseId: MAIN,
          parentSequence: 4,
          details: { finalDamage: 900 },
        }),
        plain(6, "SHIELD_CONSUMED", 5),
        plain(7, "EFFECT_EXPIRED", 6),
        plain(8, "HIT_POINT_REDUCED", 5),
        applied(9, ENEMY, 1, { untypedShieldAbsorbed: 400, hitPointDamage: 500 }),
        plain(10, "EFFECT_EXPIRED", 9),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5, 6, 7, 8, 9]],
      ["EFFECT", [10]],
    ]);
    expect(steps[3]!.hit?.calculation).toEqual({ finalDamage: 900 });
    expect(steps[3]!.hit?.application).toEqual({
      untypedShieldAbsorbed: 400,
      hitPointDamage: 500,
    });
  });

  it("does not close the hit on the DAMAGE_APPLIED of another hit", () => {
    const steps = stepsOf(
      actionWith([hit(4, ENEMY, 1), applied(5, ENEMY_2, 1), plain(6, "EFFECT_EXPIRED", 5)]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([["HIT", [4, 5, 6]]]);
  });

  it("follows target redirects and cover to the DAMAGE_APPLIED of the new defender", () => {
    const redirected = (
      sequence: number,
      reason: string,
      originalTargetUnitId: string,
      newTargetUnitId: string,
    ) =>
      event({
        sequence,
        type: "DAMAGE_REDIRECTED",
        skillUseId: MAIN,
        parentSequence: 5,
        sourceUnitId: ALLY,
        details: { reason, originalTargetUnitId, newTargetUnitId, hitIndex: 1 },
      });
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY_2, 1),
        event({
          sequence: 5,
          type: "DAMAGE_CALCULATED",
          skillUseId: MAIN,
          parentSequence: 4,
          details: { finalDamage: 900 },
        }),
        // 別ヒットの対象変更は追わない。
        event({
          sequence: 6,
          type: "DAMAGE_REDIRECTED",
          skillUseId: MAIN,
          details: {
            reason: "COVER",
            originalTargetUnitId: ENEMY_2,
            newTargetUnitId: ALLY,
            hitIndex: 2,
          },
        }),
        redirected(7, "TARGET_REDIRECT", ENEMY_2, ALLY_2),
        redirected(8, "COVER", ALLY_2, ENEMY),
        plain(9, "SHIELD_CONSUMED", 8),
        plain(10, "EFFECT_EXPIRED", 9),
        applied(11, ENEMY, 1, { untypedShieldAbsorbed: 400, hitPointDamage: 500 }),
        plain(12, "EFFECT_EXPIRED", 11),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5, 6, 7, 8, 9, 10, 11]],
      ["EFFECT", [12]],
    ]);
    expect(steps[3]!.hit).toEqual({
      targetUnitId: ENEMY_2,
      appliedTargetUnitId: ENEMY,
      hitIndex: 1,
      calculation: { finalDamage: 900 },
      application: { untypedShieldAbsorbed: 400, hitPointDamage: 500 },
    });
  });

  it("starts a new step at the next hit after a missed hit without DAMAGE_APPLIED", () => {
    const steps = stepsOf(
      actionWith([hit(4, ENEMY, 1, "SKILL_MISSED"), hit(5, ENEMY, 2), applied(6, ENEMY, 2)]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4]],
      ["HIT", [5, 6]],
    ]);
  });
});

describe("projectTraceSteps separates follow-up buffs from the hit (UI-UT-ATR-024)", () => {
  const boundary = (from: number): readonly BattleLogEventResponse[] => [
    plain(from, "EFFECT_ACTION_COMPLETED"),
    plain(from + 1, "EFFECT_STEP_COMPLETED"),
    plain(from + 2, "EFFECT_STEP_STARTING"),
    plain(from + 3, "EFFECT_ACTION_STARTING"),
  ];

  it("separates the buff after an evasion and the EffectAction boundary", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1, "EVASION_ACTIVATED"),
        ...boundary(5),
        plain(9, "EFFECT_APPLIED"),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5, 6, 7, 8]],
      ["EFFECT", [9]],
    ]);
  });

  it("keeps DAMAGE_CONVERTED_TO_HEAL in the hit and separates the following buff", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        plain(5, "DAMAGE_CALCULATED", 4),
        plain(6, "DAMAGE_CONVERTED_TO_HEAL", 5),
        plain(7, "EFFECT_APPLIED"),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5, 6]],
      ["EFFECT", [7]],
    ]);
  });

  it("separates the buff after a nullified hit that has no DAMAGE_APPLIED", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        plain(5, "DAMAGE_CALCULATED", 4),
        ...boundary(6),
        plain(10, "EFFECT_APPLIED"),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5, 6, 7, 8, 9]],
      ["EFFECT", [10]],
    ]);
  });

  it("separates the buff after a normal hit", () => {
    const steps = stepsOf(
      actionWith([hit(4, ENEMY, 1), applied(5, ENEMY, 1), plain(6, "EFFECT_APPLIED")]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4, 5]],
      ["EFFECT", [6]],
    ]);
  });

  it("closes the capture at another origin such as an interrupting PS", () => {
    const steps = stepsOf(
      actionWith([
        hit(4, ENEMY, 1),
        event({
          sequence: 5,
          type: "PASSIVE_ACTIVATED",
          skillUseId: "B:skill-use:guard",
          parentSequence: 4,
          sourceUnitId: ENEMY,
        }),
        event({
          sequence: 6,
          type: "EFFECT_APPLIED",
          skillUseId: "B:skill-use:guard",
          parentSequence: 5,
        }),
        applied(7, ENEMY, 1),
      ]),
    );
    expect(shapeOf(steps).slice(3)).toEqual([
      ["HIT", [4]],
      ["ACTIVATION", [5]],
      ["EFFECT", [6, 7]],
    ]);
  });
});

describe("projectTraceSteps reports the version after each step (UI-UT-ATR-014)", () => {
  it("uses the maximum stateVersionAfter and ends at the segment's version", () => {
    const steps = stepsOf(
      actionWith([
        event({
          sequence: 4,
          type: "HIT_CONFIRMED",
          skillUseId: MAIN,
          stateVersionAfter: 20,
          details: { targetUnitId: ENEMY, hitIndex: 1 },
        }),
        event({ sequence: 5, type: "DAMAGE_CALCULATED", skillUseId: MAIN, stateVersionAfter: 7 }),
        event({ sequence: 6, type: "ACTION_COMPLETED", stateVersionAfter: 21 }),
      ]),
    );
    expect(steps.map((step) => step.stateVersionAfter)).toEqual([1, 2, 3, 20, 21]);
    const segment = onlySegment(
      actionWith([event({ sequence: 4, type: "ACTION_COMPLETED", stateVersionAfter: 9 })]),
    );
    expect(projectTraceSteps(segment, ROSTER).at(-1)!.stateVersionAfter).toBe(
      segment.stateVersionAfter,
    );
  });

  it.each(Object.entries(FIXTURES))(
    "%s: the last step of each segment ends at the segment's version",
    (_, fixture) => {
      const roster = fixture.unitRoster ?? fixture.initialState.units;
      for (const segment of projectActionSegments(fixture.events, roster)) {
        expect(projectTraceSteps(segment, ROSTER).at(-1)!.stateVersionAfter).toBe(
          Math.max(...projectTraceSteps(segment, ROSTER).map((s) => s.stateVersionAfter)),
        );
        expect(
          Math.max(...projectTraceSteps(segment, ROSTER).map((s) => s.stateVersionAfter)),
        ).toBe(segment.stateVersionAfter);
      }
    },
  );
});
