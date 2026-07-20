import { describe, expect, it } from "vitest";
import { grantEffect } from "./effect-grant-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const BATTLE_ID = createBattleId("battle-1");
const SOURCE = createBattleUnitId("enemy:1");
const TARGET = createBattleUnitId("ally:1");
const DEFINITION_A = "ACT_BUFF_ATTACK" as EffectActionDefinitionId;
const DEFINITION_B = "ACT_BUFF_ATTACK_2" as EffectActionDefinitionId;

const NO_DURATION: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };

function unit(id: ReturnType<typeof createBattleUnitId>): BattleUnit {
  return {
    battleUnitId: id,
    unitDefinitionId: "UNIT_X" as never,
    attribute: "CUTE",
    side: id === TARGET ? "ALLY" : "ENEMY",
    position: { column: "LEFT", row: "FRONT" } as never,
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {} as never,
    currentHp: 100,
    currentAp: 0,
    currentPp: 0,
    currentExtraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
    cooldowns: {},
    appliedEffects: [],
    markers: [],
  };
}

function context(recorder: EventRecorder) {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId: undefined as never,
  };
}

describe("grantEffect (R-EFF-01/05)", () => {
  it("UT-EFF-GRANT-001: appends a new AppliedEffect to the target and records EffectApplied", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = context(recorder);
    const root = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: ctx.resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    const units = [unit(SOURCE), unit(TARGET)];

    const result = grantEffect(
      { ...ctx, rootEventId: root.eventId },
      units,
      {
        effectActionDefinitionId: DEFINITION_A,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: true,
        magnitude: 20,
        durationDefinition: NO_DURATION,
      },
      root.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects).toHaveLength(1);
    expect(targetAfter.appliedEffects[0]?.magnitude).toBe(20);
    expect(targetAfter.appliedEffects[0]?.active).toBe(true);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied).toBeDefined();
    expect(applied?.payload).toMatchObject({
      sourceUnitId: SOURCE,
      targetUnitId: TARGET,
      duplicate: true,
      magnitude: 20,
    });
  });

  it("UT-EFF-GRANT-002: a stronger non-duplicate effect dethrones the weaker one and records EffectiveEffectChanged", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = context(recorder);
    const root = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: ctx.resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    const fullContext = { ...ctx, rootEventId: root.eventId };
    const first = grantEffect(
      fullContext,
      [unit(SOURCE), unit(TARGET)],
      {
        effectActionDefinitionId: DEFINITION_A,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: false,
        magnitude: 10,
        durationDefinition: NO_DURATION,
      },
      root.eventId,
    );

    const second = grantEffect(
      fullContext,
      first.units,
      {
        effectActionDefinitionId: DEFINITION_A,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: false,
        magnitude: 30,
        durationDefinition: NO_DURATION,
      },
      first.lastEventId,
    );

    const targetAfter = second.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.find((e) => e.magnitude === 10)?.active).toBe(false);
    expect(targetAfter.appliedEffects.find((e) => e.magnitude === 30)?.active).toBe(true);

    // Fires once for the first grant (new group: none -> magnitude 10) and
    // once for the dethrone (magnitude 10 -> magnitude 30).
    const changed = recorder.getEvents().filter((e) => e.eventType === "EffectiveEffectChanged");
    expect(changed).toHaveLength(2);
    expect(changed[1]?.payload).toMatchObject({
      beforeEffectInstanceId: first.appliedEffect.effectInstanceId,
      afterEffectInstanceId: second.appliedEffect.effectInstanceId,
    });
  });

  it("UT-EFF-GRANT-003: a weaker non-duplicate effect stays inactive and does not record EffectiveEffectChanged", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = context(recorder);
    const root = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: ctx.resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    const fullContext = { ...ctx, rootEventId: root.eventId };
    const first = grantEffect(
      fullContext,
      [unit(SOURCE), unit(TARGET)],
      {
        effectActionDefinitionId: DEFINITION_A,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: false,
        magnitude: 30,
        durationDefinition: NO_DURATION,
      },
      root.eventId,
    );

    const second = grantEffect(
      fullContext,
      first.units,
      {
        effectActionDefinitionId: DEFINITION_A,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: false,
        magnitude: 10,
        durationDefinition: NO_DURATION,
      },
      first.lastEventId,
    );

    const targetAfter = second.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects.find((e) => e.magnitude === 10)?.active).toBe(false);
    // Fires once for the first grant (new group: none -> magnitude 30) but
    // not again for the second, weaker grant (the active instance is unchanged).
    expect(
      recorder.getEvents().filter((e) => e.eventType === "EffectiveEffectChanged"),
    ).toHaveLength(1);
  });

  it("UT-EFF-GRANT-004: sets grantedActionId for an ACTION-unit duration so R-EFF-04's initial-decrement exclusion can key off it", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const actionId = recorder.nextActionId();
    const ctx = { ...context(recorder), actionId };
    const root = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: ctx.resolutionScopeId,
      payload: {
        actorUnitId: TARGET,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 3,
        apAfter: 2,
        exBefore: 0,
        exAfter: 0,
      },
    });

    const result = grantEffect(
      { ...ctx, rootEventId: root.eventId },
      [unit(SOURCE), unit(TARGET)],
      {
        effectActionDefinitionId: DEFINITION_B,
        sourceId: SOURCE,
        targetId: TARGET,
        duplicate: true,
        magnitude: 5,
        durationDefinition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      root.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.appliedEffects[0]?.duration.grantedActionId).toBe(actionId);
    expect(targetAfter.appliedEffects[0]?.duration.timeLimitRemaining).toBe(2);
  });
});
