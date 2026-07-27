import { describe, expect, it } from "vitest";
import { grantFreezeStatus } from "./freeze-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createActionId, type createDomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
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

function seedRecorder(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<typeof createDomainEventId>;
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

const FREEZE_ACTION_ID = createEffectActionDefinitionId("ACT_FREEZE");

function freezeDuration(count: number): DurationDefinition {
  return { timeLimit: { unit: "ACTION", count }, dispellable: true, linkedEffectGroupId: null };
}

describe("grantFreezeStatus (R-STS-03)", () => {
  it("UT-R-STS-03-001: grants a new FREEZE AppliedEffect when the target has none yet", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();

    const result = grantFreezeStatus(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, target],
      {
        effectActionDefinitionId: FREEZE_ACTION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "FREEZE",
        statusDetails: { damageAmplificationOnBreak: 1.5 },
        durationDefinition: freezeDuration(3),
      },
      rootEventId,
    );

    const grantedTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      statusKind: "FREEZE",
      statusDetails: { damageAmplificationOnBreak: 1.5 },
      duration: { timeLimitRemaining: 3 },
    });
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
  });

  it("UT-R-STS-03-002 (R-STS-03 '再付与時に期間延長や増幅率加算を行わない'): re-granting FREEZE to an already-frozen target leaves the existing instance completely unchanged, even with a longer duration or different amplification, and records no new event", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = {
      recorder,
      turnNumber: 1,
      cycleNumber: 0,
      actionId: createActionId("B_1:action:1"),
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId,
    };

    const first = grantFreezeStatus(
      context,
      [source, target],
      {
        effectActionDefinitionId: FREEZE_ACTION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "FREEZE",
        statusDetails: { damageAmplificationOnBreak: 1.5 },
        durationDefinition: freezeDuration(1),
      },
      rootEventId,
    );
    const firstTarget = first.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    const firstInstanceId = firstTarget.appliedEffects[0]!.effectInstanceId;
    const eventCountAfterFirst = recorder.getEvents().length;

    const second = grantFreezeStatus(
      context,
      first.units,
      {
        effectActionDefinitionId: FREEZE_ACTION_ID,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "FREEZE",
        statusDetails: { damageAmplificationOnBreak: 2 },
        durationDefinition: freezeDuration(99),
      },
      first.lastEventId,
    );
    const secondTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;

    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]!.effectInstanceId).toBe(firstInstanceId);
    expect(secondTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(1);
    expect(secondTarget.appliedEffects[0]!.statusDetails).toEqual({
      damageAmplificationOnBreak: 1.5,
    });
    expect(recorder.getEvents()).toHaveLength(eventCountAfterFirst);
    expect(second.lastEventId).toBe(first.lastEventId);
  });

  it("UT-R-STS-03-003: does not touch the target's pending charge (R-STS-03 'チャージをキャンセルしない')", () => {
    const source = unit("source-1");
    const chargedTarget = {
      ...unit("target-1"),
      charge: { skill: {}, startedActionId: {} } as unknown as NonNullable<BattleUnit["charge"]>,
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = grantFreezeStatus(
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId,
      },
      [source, chargedTarget],
      {
        effectActionDefinitionId: FREEZE_ACTION_ID,
        sourceId: source.battleUnitId,
        targetId: chargedTarget.battleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: "FREEZE",
        durationDefinition: freezeDuration(1),
      },
      rootEventId,
    );

    const grantedTarget = result.units.find((u) => u.battleUnitId === chargedTarget.battleUnitId)!;
    expect(grantedTarget.charge).toBeDefined();
    expect(recorder.getEvents().some((e) => e.eventType === "ChargeCancelled")).toBe(false);
  });
});
