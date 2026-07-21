import { describe, expect, it } from "vitest";
import {
  consumeEffectDurations,
  decrementActionEffectDurations,
  decrementTurnEffectDurations,
  resolveTimeLimitOwnerUnitId,
} from "./applied-effect-duration.js";
import { createBattleUnit, type BattleUnit } from "./battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "./applied-effect.js";
import type { BattlePartyMember } from "./battle-party.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_ATK_UP");

function effectOn(
  target: BattleUnit,
  source: BattleUnit,
  durationDefinition: DurationDefinition,
  overrides: Partial<AppliedEffect> = {},
): AppliedEffect {
  const timeLimit = durationDefinition.timeLimit;
  return {
    effectInstanceId: createEffectInstanceId(`effect:${target.battleUnitId}:${Math.random()}`),
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
    duplicate: true,
    sourceId: source.battleUnitId,
    targetId: target.battleUnitId,
    magnitude: 10,
    duration: {
      definition: durationDefinition,
      ...(timeLimit !== undefined ? { timeLimitRemaining: timeLimit.count } : {}),
    },
    appliedTurnNumber: 1,
    ...overrides,
  };
}

function withEffects(target: BattleUnit, effects: readonly AppliedEffect[]): BattleUnit {
  return { ...target, appliedEffects: effects };
}

describe("resolveTimeLimitOwnerUnitId", () => {
  it("UT-R-EFF-04-001 (R-EFF-04): resolves EFFECT_TARGET to the effect's targetId", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const effect = effectOn(target, source, {
      timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
      dispellable: true,
      linkedEffectGroupId: null,
    });

    expect(resolveTimeLimitOwnerUnitId(effect)).toBe(target.battleUnitId);
  });

  it("UT-R-EFF-04-002 (R-EFF-04): resolves EFFECT_SOURCE to the effect's sourceId", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const effect = effectOn(target, source, {
      timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
      dispellable: true,
      linkedEffectGroupId: null,
    });

    expect(resolveTimeLimitOwnerUnitId(effect)).toBe(source.battleUnitId);
  });

  it("UT-R-EFF-04-003 (R-EFF-04): resolves BATTLE to the BATTLE sentinel", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const effect = effectOn(target, source, {
      timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
      dispellable: true,
      linkedEffectGroupId: null,
    });

    expect(resolveTimeLimitOwnerUnitId(effect)).toBe("BATTLE");
  });

  it("UT-R-EFF-04-004 (R-EFF-04): defaults to EFFECT_TARGET when owner is omitted", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const effect = effectOn(target, source, {
      timeLimit: { unit: "ACTION", count: 1 },
      dispellable: true,
      linkedEffectGroupId: null,
    });

    expect(resolveTimeLimitOwnerUnitId(effect)).toBe(target.battleUnitId);
  });
});

describe("decrementActionEffectDurations", () => {
  it("UT-R-EFF-04-005 (R-EFF-04 #2/#6 Q-EFF-08): does not decrement on the same action the effect was granted in", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const grantingActionId = createActionId("B_1:action:1");
    const effect = effectOn(
      target,
      source,
      {
        timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 2,
          grantedActionId: grantingActionId,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementActionEffectDurations(
      [source, target],
      target.battleUnitId,
      grantingActionId,
    );

    expect(result.changes).toHaveLength(0);
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-R-EFF-04-006 (R-EFF-04 #3/#4): decrements by 1 when the owner (EFFECT_TARGET) completes a later action, not on other units' actions", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const grantingActionId = createActionId("B_1:action:1");
    const nextActionId = createActionId("B_1:action:2");
    const effect = effectOn(
      target,
      source,
      {
        timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_TARGET" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 2,
          grantedActionId: grantingActionId,
        },
      },
    );
    target = withEffects(target, [effect]);

    // Other unit's action must not decrement it.
    const untouched = decrementActionEffectDurations(
      [source, target],
      source.battleUnitId,
      nextActionId,
    );
    expect(untouched.changes).toHaveLength(0);

    const result = decrementActionEffectDurations(
      [source, target],
      target.battleUnitId,
      nextActionId,
    );
    expect(result.changes).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit: "ACTION",
        before: 2,
        after: 1,
      },
    ]);
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(1);
  });

  it("UT-R-EFF-04-007 (R-EFF-04 owner=EFFECT_SOURCE): decrements on the SOURCE's action even though the instance is held by the target", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const grantingActionId = createActionId("B_1:action:1");
    const sourceNextActionId = createActionId("B_1:action:3");
    const effect = effectOn(
      target,
      source,
      {
        timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 1,
          grantedActionId: grantingActionId,
        },
      },
    );
    target = withEffects(target, [effect]);

    // The target's own action must not decrement a SOURCE-owned duration.
    const untouched = decrementActionEffectDurations(
      [source, target],
      target.battleUnitId,
      createActionId("B_1:action:2"),
    );
    expect(untouched.changes).toHaveLength(0);

    const result = decrementActionEffectDurations(
      [source, target],
      source.battleUnitId,
      sourceNextActionId,
    );
    expect(result.changes).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit: "ACTION",
        before: 1,
        after: 0,
      },
    ]);
  });

  it("UT-R-EFF-04-008 (R-EFF-04 owner=BATTLE): decrements on ANY unit's action completion", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const other = unit("other-1");
    const grantingActionId = createActionId("B_1:action:1");
    const effect = effectOn(
      target,
      source,
      {
        timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 1,
          grantedActionId: grantingActionId,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementActionEffectDurations(
      [source, target, other],
      other.battleUnitId,
      createActionId("B_1:action:2"),
    );

    expect(result.changes).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit: "ACTION",
        before: 1,
        after: 0,
      },
    ]);
  });

  it("UT-R-EFF-04-009 (R-EFF-04 #5 boundary): expiring instance (after=0) is not removed by the decrement function itself", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const grantingActionId = createActionId("B_1:action:1");
    const effect = effectOn(
      target,
      source,
      {
        timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 1,
          grantedActionId: grantingActionId,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementActionEffectDurations(
      [source, target],
      target.battleUnitId,
      createActionId("B_1:action:2"),
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(1);
    expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(0);
  });

  it("UT-R-EFF-04-010: ignores TURN-unit and battle-persistent effects", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const turnEffect = effectOn(target, source, {
      timeLimit: { unit: "TURN", count: 2 },
      dispellable: true,
      linkedEffectGroupId: null,
    });
    const battleEffect = effectOn(target, source, { dispellable: true, linkedEffectGroupId: null });
    target = withEffects(target, [turnEffect, battleEffect]);

    const result = decrementActionEffectDurations(
      [source, target],
      target.battleUnitId,
      createActionId("B_1:action:9"),
    );

    expect(result.changes).toHaveLength(0);
  });
});

describe("decrementTurnEffectDurations", () => {
  it("UT-R-EFF-06-001 (R-EFF-06 #1/Q-EFF-12): does not decrement on the turn the effect was granted in", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const effect = effectOn(
      target,
      source,
      { timeLimit: { unit: "TURN", count: 2 }, dispellable: true, linkedEffectGroupId: null },
      {
        duration: {
          definition: {
            timeLimit: { unit: "TURN", count: 2 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 2,
          grantedTurnNumber: 3,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementTurnEffectDurations([source, target], 3);

    expect(result.changes).toHaveLength(0);
  });

  it("UT-R-EFF-06-002 (R-EFF-06 #2/Q-EFF-12): decrements by 1 from the next turn end regardless of which unit is queried", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const effect = effectOn(
      target,
      source,
      { timeLimit: { unit: "TURN", count: 2 }, dispellable: true, linkedEffectGroupId: null },
      {
        duration: {
          definition: {
            timeLimit: { unit: "TURN", count: 2 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 2,
          grantedTurnNumber: 3,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementTurnEffectDurations([source, target], 4);

    expect(result.changes).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit: "TURN",
        before: 2,
        after: 1,
      },
    ]);
  });

  it("UT-R-EFF-06-003 (R-EFF-06 #2 boundary): reaches 0 and stays in place for the caller to expire", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const effect = effectOn(
      target,
      source,
      { timeLimit: { unit: "TURN", count: 1 }, dispellable: true, linkedEffectGroupId: null },
      {
        duration: {
          definition: {
            timeLimit: { unit: "TURN", count: 1 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          timeLimitRemaining: 1,
          grantedTurnNumber: 3,
        },
      },
    );
    target = withEffects(target, [effect]);

    const result = decrementTurnEffectDurations([source, target], 4);

    expect(result.changes[0]).toMatchObject({ before: 1, after: 0 });
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(0);
  });

  it("UT-R-EFF-06-004: ignores ACTION-unit and battle-persistent effects", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const actionEffect = effectOn(target, source, {
      timeLimit: { unit: "ACTION", count: 2 },
      dispellable: true,
      linkedEffectGroupId: null,
    });
    const battleEffect = effectOn(target, source, { dispellable: true, linkedEffectGroupId: null });
    target = withEffects(target, [actionEffect, battleEffect]);

    const result = decrementTurnEffectDurations([source, target], 4);

    expect(result.changes).toHaveLength(0);
  });
});

describe("consumeEffectDurations", () => {
  it("UT-R-EFF-07-001 (R-EFF-07): decrements the consumption remaining count of an owned effect matching the given kind", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const e = effectOn(
      target,
      source,
      {
        consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          consumptionRemaining: 1,
        },
      },
    );
    target = withEffects(target, [e]);

    const result = consumeEffectDurations(
      [source, target],
      target.battleUnitId,
      "NEXT_OUTGOING_ATTACK",
    );

    expect(result.changes).toEqual([
      {
        battleUnitId: target.battleUnitId,
        effectInstanceId: e.effectInstanceId,
        kind: "NEXT_OUTGOING_ATTACK",
        before: 1,
        after: 0,
      },
    ]);
    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects[0]!.duration.consumptionRemaining).toBe(0);
  });

  it("UT-R-EFF-07-002: ignores effects with a different consumption kind or no consumption clause", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const wrongKind = effectOn(
      target,
      source,
      {
        consumption: { kind: "INCOMING_HIT", maxCount: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            consumption: { kind: "INCOMING_HIT", maxCount: 2 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          consumptionRemaining: 2,
        },
      },
    );
    const noConsumption = effectOn(target, source, {
      dispellable: true,
      linkedEffectGroupId: null,
    });
    target = withEffects(target, [wrongKind, noConsumption]);

    const result = consumeEffectDurations(
      [source, target],
      target.battleUnitId,
      "NEXT_OUTGOING_ATTACK",
    );

    expect(result.changes).toHaveLength(0);
  });

  it("UT-R-EFF-07-003: only decrements effects held by the given owner, not other units'", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const other = unit("other-1");
    const e = effectOn(
      target,
      source,
      {
        consumption: { kind: "OUTGOING_HIT", maxCount: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            consumption: { kind: "OUTGOING_HIT", maxCount: 1 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          consumptionRemaining: 1,
        },
      },
    );
    target = withEffects(target, [e]);

    const result = consumeEffectDurations(
      [source, target, other],
      other.battleUnitId,
      "OUTGOING_HIT",
    );

    expect(result.changes).toHaveLength(0);
  });

  it("UT-R-EFF-07-004 (boundary): does not decrement below 0 / a already-0 remaining count", () => {
    const source = unit("source-1");
    let target = unit("target-1");
    const e = effectOn(
      target,
      source,
      {
        consumption: { kind: "OUTGOING_HIT", maxCount: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      {
        duration: {
          definition: {
            consumption: { kind: "OUTGOING_HIT", maxCount: 1 },
            dispellable: true,
            linkedEffectGroupId: null,
          },
          consumptionRemaining: 0,
        },
      },
    );
    target = withEffects(target, [e]);

    const result = consumeEffectDurations([source, target], target.battleUnitId, "OUTGOING_HIT");

    expect(result.changes).toHaveLength(0);
  });
});
