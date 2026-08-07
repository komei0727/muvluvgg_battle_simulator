import { describe, expect, it } from "vitest";
import { applyModifyResourceAction } from "./resource-modification-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import { DomainValidationError } from "../../shared/errors.js";

function unit(
  id: string,
  side: Side,
  overrides: { currentHp?: number; maximumHp?: number } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...built, currentHp: overrides.currentHp ?? built.currentHp };
}

function modifyResourceAction(
  id: string,
  payload: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE" }>["payload"],
): Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE" }> {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "MODIFY_RESOURCE",
    payload,
    metadata: { tags: [] },
  };
}

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"];
} {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

describe("applyModifyResourceAction (R-ACTN-02, M7-002 Issue #185)", () => {
  it("UT-R-ACTN-02-001 (HP_DIRECT_COST): MODIFY_RESOURCE(resource: HP, ADD, MAX_HP_RATIO -10%) reduces current HP by 10% of max, emitting ResourceChanged(resource: HP, reason: EFFECT_ACTION)", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 100, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: -0.1 },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.currentHp).toBe(90);

    const resourceChanged = recorder.getEvents().find((e) => e.eventType === "ResourceChanged")!;
    expect(resourceChanged.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      resource: "HP",
      before: 100,
      after: 90,
      delta: -10,
      baseDelta: -10,
      reason: "EFFECT_ACTION",
    });
  });

  it("UT-R-ACTN-02-002: a HP cost that would go below 0 clamps to 0 (default bounds 0..currentMax)", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 5, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST_BIG", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: -0.6 },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.currentHp).toBe(0);
  });

  it("UT-R-ACTN-02-003: HP reaching 0 via MODIFY_RESOURCE emits UnitDefeated", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST_LETHAL", {
      resource: "HP",
      operation: "SET",
      formula: { kind: "CONSTANT", value: 0 },
    });
    const { recorder, rootEventId } = seedRecorder();

    applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(recorder.getEvents().some((e) => e.eventType === "UnitDefeated")).toBe(true);
  });

  it("UT-R-ACTN-02-004: SET_TO_MAX ignores the (placeholder) formula and sets the resource to its current max", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 40, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_FULL", {
      resource: "HP",
      operation: "SET_TO_MAX",
      formula: { kind: "CONSTANT", value: 0 },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-ACTN-02-005: an explicit bounds.min overrides the default 0 floor", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST_FLOORED", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: -50 },
      bounds: { min: 1, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(1);
  });

  it("UT-R-ACTN-02-009: an author-supplied negative bounds.min is still intersected with the hard floor of 0", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST_OVERSHOOT", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: -50 },
      bounds: { min: -999, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(0);
  });

  it("UT-R-ACTN-02-010: an author-supplied bounds.max exceeding the resource's current max is still intersected with currentMax", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_GAIN_OVERSHOOT", {
      resource: "HP",
      operation: "SET",
      formula: { kind: "CONSTANT", value: 500 },
      bounds: { min: 0, max: 500 },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-ACTN-02-011: an author-supplied bounds range that is empty after intersection with [0, currentMax] (e.g. bounds: {min: 0, max: -1}) still clamps to a valid value instead of throwing", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_COST_EMPTY_BOUNDS", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: -5 },
      bounds: { min: 0, max: -1 },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(0);
  });

  it("UT-R-ACTN-02-014: an author-supplied bounds.min exceeding currentMax (e.g. bounds: {min: 999, max: CURRENT_MAX} on a 100-max HP) still clamps to currentMax instead of throwing", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_MIN_OVERSHOOT", {
      resource: "HP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: -5 },
      bounds: { min: 999, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(100);
  });

  it("UT-R-ACTN-02-015 (DISTRIBUTE): the Formula result is one total amount split evenly across the share count and added to every target", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    const action = modifyResourceAction("ACT_EX_DISTRIBUTE", {
      resource: "EX_GAUGE",
      operation: "DISTRIBUTE",
      formula: { kind: "CONSTANT", value: 8 },
      bounds: { min: 0, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [actor, ally].map((target, hitIndex) => ({
        targetUnitId: target.battleUnitId,
        effectActionDefinitionId: action.effectActionDefinitionId,
        hitIndex,
      })),
      actor,
      action,
      [actor, ally],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
      2,
    );

    // 総量8をシェア数2で等分 — 対象ごとに8を配るADDとは異なる。
    for (const target of [actor, ally]) {
      expect(
        result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
    }
    expect(result.changed).toBe(true);
    expect(result.resolvedCount).toBe(2);
    const changes = recorder.getEvents().filter((e) => e.eventType === "ResourceChanged");
    expect(changes).toHaveLength(2);
    for (const change of changes) {
      expect(change.payload).toMatchObject({
        resource: "EX_GAUGE",
        before: 0,
        after: 4,
        delta: 4,
        baseDelta: 4,
        reason: "EFFECT_ACTION",
      });
    }
  });

  it("UT-R-ACTN-02-016 (DISTRIBUTE, BOUNDARY): an indivisible total truncates once per target (R-NUM-02) rather than distributing the remainder", () => {
    const targets = [unit("ACTOR", "ALLY"), unit("ALLY_2", "ALLY"), unit("ALLY_3", "ALLY")];
    const action = modifyResourceAction("ACT_EX_DISTRIBUTE", {
      resource: "EX_GAUGE",
      operation: "DISTRIBUTE",
      formula: { kind: "CONSTANT", value: 8 },
      bounds: { min: 0, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      targets.map((target, hitIndex) => ({
        targetUnitId: target.battleUnitId,
        effectActionDefinitionId: action.effectActionDefinitionId,
        hitIndex,
      })),
      targets[0]!,
      action,
      targets,
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: targets[0]!.battleUnitId,
      },
      3,
    );

    // 8 / 3 = 2.666… → 各対象2（端数は切り捨てて破棄する。`HEAL`の
    // `distribution: "EVEN"`と同じ規約）。
    for (const target of targets) {
      expect(
        result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
      ).toBe(2);
    }
  });

  it("UT-R-ACTN-02-017 (DISTRIBUTE, BOUNDARY): a target already at its current maximum keeps its share unapplied and emits no ResourceChanged, while the others still receive theirs", () => {
    const actor = unit("ACTOR", "ALLY");
    const full = { ...unit("ALLY_FULL", "ALLY"), currentExtraGauge: 10 };
    const action = modifyResourceAction("ACT_EX_DISTRIBUTE", {
      resource: "EX_GAUGE",
      operation: "DISTRIBUTE",
      formula: { kind: "CONSTANT", value: 8 },
      bounds: { min: 0, max: "CURRENT_MAX" },
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyModifyResourceAction(
      [actor, full].map((target, hitIndex) => ({
        targetUnitId: target.battleUnitId,
        effectActionDefinitionId: action.effectActionDefinitionId,
        hitIndex,
      })),
      actor,
      action,
      [actor, full],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
      2,
    );

    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge).toBe(
      4,
    );
    expect(result.units.find((u) => u.battleUnitId === full.battleUnitId)!.currentExtraGauge).toBe(
      10,
    );
    // 打ち止めの対象は変化0なので`ResourceChanged`を発行しない（ADDと同じ規約）。
    const changes = recorder.getEvents().filter((e) => e.eventType === "ResourceChanged");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ battleUnitId: actor.battleUnitId, delta: 4 });
    expect(result.resolvedCount).toBe(2);
  });

  it("UT-R-ACTN-02-018 (DISTRIBUTE, NEGATIVE): a share count that is not a positive integer is rejected with a DomainValidationError instead of producing Infinity or NaN resources", () => {
    const actor = unit("ACTOR", "ALLY");
    const action = modifyResourceAction("ACT_EX_DISTRIBUTE", {
      resource: "EX_GAUGE",
      operation: "DISTRIBUTE",
      formula: { kind: "CONSTANT", value: 8 },
    });
    const { recorder, rootEventId } = seedRecorder();

    for (const shareCount of [0, -1, 1.5]) {
      expect(() =>
        applyModifyResourceAction(
          [
            {
              targetUnitId: actor.battleUnitId,
              effectActionDefinitionId: action.effectActionDefinitionId,
              hitIndex: 0,
            },
          ],
          actor,
          action,
          [actor],
          {
            recorder,
            turnNumber: 1,
            cycleNumber: 0,
            resolutionScopeId: recorder.nextResolutionScopeId(),
            rootEventId,
            parentEventId: rootEventId,
            sourceUnitId: actor.battleUnitId,
          },
          shareCount,
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-R-ACTN-02-007: a zero-delta change (already at the target value) does not emit ResourceChanged", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 100, maximumHp: 100 });
    const action = modifyResourceAction("ACT_HP_FULL_NOOP", {
      resource: "HP",
      operation: "SET_TO_MAX",
      formula: { kind: "CONSTANT", value: 0 },
    });
    const { recorder, rootEventId } = seedRecorder();

    applyModifyResourceAction(
      [
        {
          targetUnitId: actor.battleUnitId,
          effectActionDefinitionId: action.effectActionDefinitionId,
          hitIndex: 0,
        },
      ],
      actor,
      action,
      [actor],
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
        parentEventId: rootEventId,
        sourceUnitId: actor.battleUnitId,
      },
    );

    expect(recorder.getEvents().some((e) => e.eventType === "ResourceChanged")).toBe(false);
  });
});
