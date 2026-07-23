import { describe, expect, it } from "vitest";
import {
  applyMatchedEffectSequenceRuntimeCounterUpdate,
  matchEffectSequenceRuntimeCounterUpdates,
  type ActiveEffectSequenceResolution,
} from "./effect-sequence-runtime-counter-matcher.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createSkillUseId } from "../../shared/event-ids.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { RuntimeCounterUpdateDefinitionInput } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { createRuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side = "ALLY", overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position = { row: "FRONT", column: "LEFT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

const SKILL_DEFINITION_ID = createSkillDefinitionId("SKL_AS1");
const SKILL_USE_ID = createSkillUseId("skilluse-1");
const HIT_COUNTER = createRuntimeCounterId("RUNTIME_COUNTER_SEQ_HITS");

function actionCompletedTrigger(): RuntimeCounterUpdateDefinitionInput["trigger"] {
  return {
    eventType: "EffectActionCompleted",
    category: "FACT",
    sourceSelector: "SELF",
    targetSelector: "ANY",
  };
}

function resolutionWithCounterUpdates(
  actorId: BattleUnit["battleUnitId"],
  counterUpdates: readonly RuntimeCounterUpdateDefinitionInput[],
): ActiveEffectSequenceResolution {
  return {
    actorId,
    skillDefinitionId: SKILL_DEFINITION_ID,
    counterUpdates: counterUpdates.map((c, i) =>
      createRuntimeCounterUpdateDefinition(c, `counterUpdates[${i}]`),
    ),
  };
}

function actionCompletedEvent(sourceUnitId: BattleUnit["battleUnitId"]): TriggerCandidateEvent {
  return {
    eventType: "EffectActionCompleted",
    category: "FACT",
    sourceUnitId,
    payload: {},
  };
}

describe("matchEffectSequenceRuntimeCounterUpdates", () => {
  it("UT-RCOUNTER-SEQ-001 (EFF-006 Issue #212): matches an active resolution's own counterUpdates when its trigger matches", () => {
    const actor = unit("actor-1", "ALLY");
    const resolution = resolutionWithCounterUpdates(actor.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]);
    const activeResolutions = new Map([[SKILL_USE_ID, resolution]]);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      activeResolutions,
      [actor],
      actionCompletedEvent(actor.battleUnitId),
    );

    expect(matched).toEqual([
      {
        skillUseId: SKILL_USE_ID,
        actorId: actor.battleUnitId,
        skillDefinitionId: SKILL_DEFINITION_ID,
        update: resolution.counterUpdates[0],
      },
    ]);
  });

  it("UT-RCOUNTER-SEQ-002: does not match a resolution with no counterUpdates", () => {
    const actor = unit("actor-1", "ALLY");
    const resolution = resolutionWithCounterUpdates(actor.battleUnitId, []);
    const activeResolutions = new Map([[SKILL_USE_ID, resolution]]);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      activeResolutions,
      [actor],
      actionCompletedEvent(actor.battleUnitId),
    );

    expect(matched).toHaveLength(0);
  });

  it("UT-RCOUNTER-SEQ-003: skips a resolution whose actor is defeated", () => {
    const actor = { ...unit("actor-1", "ALLY"), currentHp: 0 };
    const resolution = resolutionWithCounterUpdates(actor.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]);
    const activeResolutions = new Map([[SKILL_USE_ID, resolution]]);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      activeResolutions,
      [actor],
      actionCompletedEvent(actor.battleUnitId),
    );

    expect(matched).toHaveLength(0);
  });

  it("UT-RCOUNTER-SEQ-004: skips a resolution whose actor is no longer present in units", () => {
    const resolution = resolutionWithCounterUpdates(createBattleUnitId("gone"), [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]);
    const activeResolutions = new Map([[SKILL_USE_ID, resolution]]);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      activeResolutions,
      [],
      actionCompletedEvent(createBattleUnitId("gone")),
    );

    expect(matched).toHaveLength(0);
  });

  it("UT-RCOUNTER-SEQ-005: multiple active resolutions are matched independently, each against its own counters", () => {
    const actorA = unit("actor-a", "ALLY");
    const actorB = unit("actor-b", "ALLY");
    const skillUseIdA = createSkillUseId("skilluse-a");
    const skillUseIdB = createSkillUseId("skilluse-b");
    const anyTrigger: RuntimeCounterUpdateDefinitionInput["trigger"] = {
      ...actionCompletedTrigger(),
      sourceSelector: "ANY",
    };
    const resolutionA = resolutionWithCounterUpdates(actorA.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: anyTrigger,
        amount: 1,
      },
    ]);
    const resolutionB = resolutionWithCounterUpdates(actorB.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: anyTrigger,
        amount: 1,
      },
    ]);
    const activeResolutions = new Map([
      [skillUseIdA, resolutionA],
      [skillUseIdB, resolutionB],
    ]);

    const matched = matchEffectSequenceRuntimeCounterUpdates(
      activeResolutions,
      [actorA, actorB],
      actionCompletedEvent(actorA.battleUnitId),
    );

    expect(matched.map((m) => m.skillUseId)).toEqual([skillUseIdA, skillUseIdB]);
  });

  it("UT-RCOUNTER-SEQ-006: throws when a resolution declares a non-EFFECT_SEQUENCE scope (defensive, Catalog validation should already reject this)", () => {
    const actor = unit("actor-1", "ALLY");
    const resolution: ActiveEffectSequenceResolution = {
      actorId: actor.battleUnitId,
      skillDefinitionId: SKILL_DEFINITION_ID,
      counterUpdates: [
        createRuntimeCounterUpdateDefinition(
          {
            kind: "INCREMENT",
            counter: "RUNTIME_COUNTER_SEQ_HITS",
            scope: "SKILL_RUNTIME",
            trigger: actionCompletedTrigger(),
            amount: 1,
          },
          "counterUpdates[0]",
        ),
      ],
    };
    const activeResolutions = new Map([[SKILL_USE_ID, resolution]]);

    expect(() =>
      matchEffectSequenceRuntimeCounterUpdates(
        activeResolutions,
        [actor],
        actionCompletedEvent(actor.battleUnitId),
      ),
    ).toThrow(DomainValidationError);
  });
});

describe("applyMatchedEffectSequenceRuntimeCounterUpdate", () => {
  it("UT-RCOUNTER-SEQ-007: increments the matched resolution's own counter and reports the change", () => {
    const actor = unit("actor-1", "ALLY");
    const resolution = resolutionWithCounterUpdates(actor.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]);

    const result = applyMatchedEffectSequenceRuntimeCounterUpdate(
      {
        skillUseId: SKILL_USE_ID,
        actorId: actor.battleUnitId,
        skillDefinitionId: SKILL_DEFINITION_ID,
        update: resolution.counterUpdates[0]!,
      },
      [actor],
      actionCompletedEvent(actor.battleUnitId),
    );

    expect(result.change).toEqual({
      actorId: actor.battleUnitId,
      skillUseId: SKILL_USE_ID,
      skillDefinitionId: SKILL_DEFINITION_ID,
      counter: HIT_COUNTER,
      before: 0,
      after: 1,
      carry: 0,
      carryBefore: 0,
      valueChanged: true,
    });
    const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updatedActor.effectSequenceCounters).toEqual({
      [SKILL_USE_ID]: { [HIT_COUNTER]: { value: 1, carry: 0 } },
    });
  });

  it("UT-RCOUNTER-SEQ-008: a second update only replaces the changed counter for the same SkillUseId", () => {
    const actor = unit("actor-1", "ALLY");
    const update = resolutionWithCounterUpdates(actor.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]).counterUpdates[0]!;

    const first = applyMatchedEffectSequenceRuntimeCounterUpdate(
      {
        skillUseId: SKILL_USE_ID,
        actorId: actor.battleUnitId,
        skillDefinitionId: SKILL_DEFINITION_ID,
        update,
      },
      [actor],
      actionCompletedEvent(actor.battleUnitId),
    );
    const second = applyMatchedEffectSequenceRuntimeCounterUpdate(
      {
        skillUseId: SKILL_USE_ID,
        actorId: actor.battleUnitId,
        skillDefinitionId: SKILL_DEFINITION_ID,
        update,
      },
      first.units,
      actionCompletedEvent(actor.battleUnitId),
    );

    expect(second.change?.before).toBe(1);
    expect(second.change?.after).toBe(2);
    const updatedActor = second.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updatedActor.effectSequenceCounters).toEqual({
      [SKILL_USE_ID]: { [HIT_COUNTER]: { value: 2, carry: 0 } },
    });
  });

  it("UT-RCOUNTER-SEQ-009: throws when the actor battleUnitId disappears from units", () => {
    const actor = unit("actor-1", "ALLY");
    const update = resolutionWithCounterUpdates(actor.battleUnitId, [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SEQ_HITS",
        scope: "EFFECT_SEQUENCE",
        trigger: actionCompletedTrigger(),
        amount: 1,
      },
    ]).counterUpdates[0]!;

    expect(() =>
      applyMatchedEffectSequenceRuntimeCounterUpdate(
        {
          skillUseId: SKILL_USE_ID,
          actorId: actor.battleUnitId,
          skillDefinitionId: SKILL_DEFINITION_ID,
          update,
        },
        [],
        actionCompletedEvent(actor.battleUnitId),
      ),
    ).toThrow(DomainValidationError);
  });
});
