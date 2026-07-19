import { describe, expect, it } from "vitest";
import { recordActionCompletion } from "./action-completion.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId } from "../../shared/event-ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

function actorWithExpiringCooldown(): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("U1"),
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
  const built = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return {
    ...built,
    cooldowns: {
      // Set by a DIFFERENT action than the one completing below, so
      // `decrementActionCooldowns` reduces it (R-SKL-04 COMPLETING #3) and,
      // since `remaining` reaches 0, also emits `CooldownCompleted`.
      [createSkillDefinitionId("SKL_OTHER")]: {
        unit: "ACTION",
        remaining: 1,
        setActionId: createActionId("B_1:action:0"),
      },
    },
  };
}

describe("recordActionCompletion", () => {
  it("UT-ACT-COMPLETION-001 (review re-fix [P2]): threads ActionCompleting/CooldownReduced/CooldownCompleted/ActionCompleted through the optional onFactEventForPassiveChain hook, in event order, and returns the hook's own final units (not just the internally batch-decremented ones)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const initialActor = actorWithExpiringCooldown();
    const notifiedEventTypes: string[] = [];
    // Simulates a PS that increases HP by 1 every time it is invoked, so the
    // test can prove `recordActionCompletion`'s returned `units` are the
    // hook's own returned units, threaded across all 4 calls.
    const onFactEventForPassiveChain = (
      event: BattleDomainEvent,
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] => {
      notifiedEventTypes.push(event.eventType);
      return units.map((u) =>
        u.battleUnitId === initialActor.battleUnitId ? { ...u, currentHp: u.currentHp + 1 } : u,
      );
    };

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: initialActor.battleUnitId,
        onFactEventForPassiveChain,
      },
      "AS",
      seed.eventId,
      [initialActor],
    );

    expect(notifiedEventTypes).toEqual([
      "ActionCompleting",
      "CooldownReduced",
      "CooldownCompleted",
      "ActionCompleted",
    ]);
    expect(result.units[0]?.currentHp).toBe(initialActor.currentHp + notifiedEventTypes.length);
  });

  it("UT-ACT-COMPLETION-002 (review re-fix [P2]): omitting onFactEventForPassiveChain behaves exactly as before (no hook calls, the batch-decremented units are returned as-is)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const initialActor = actorWithExpiringCooldown();

    const result = recordActionCompletion(
      recorder,
      {
        actionId: createActionId("B_1:action:1"),
        resolutionScopeId: recorder.nextResolutionScopeId(),
        rootEventId: seed.eventId,
        turnNumber: 1,
        cycleNumber: 1,
        actorId: initialActor.battleUnitId,
      },
      "AS",
      seed.eventId,
      [initialActor],
    );

    expect(result.units[0]?.currentHp).toBe(initialActor.currentHp);
    expect(result.units[0]?.cooldowns[createSkillDefinitionId("SKL_OTHER")]?.remaining).toBe(0);
  });
});
