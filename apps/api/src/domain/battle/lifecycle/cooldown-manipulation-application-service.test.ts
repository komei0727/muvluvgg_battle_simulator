import { describe, expect, it } from "vitest";
import {
  applyCooldownManipulationAction,
  type CooldownManipulationEventContext,
} from "./cooldown-manipulation-application-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string, targetSkillId: ReturnType<typeof createSkillDefinitionId>): BattleUnit {
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
  const built = createBattleUnit(member, "ALLY", LIMITS);
  return {
    ...built,
    cooldowns: { [targetSkillId]: { unit: "ACTION", remaining: 2 } },
  };
}

function resetAction(
  targetSkillId: ReturnType<typeof createSkillDefinitionId>,
): Extract<EffectActionDefinition, { kind: "COOLDOWN_MANIPULATION" }> {
  return {
    kind: "COOLDOWN_MANIPULATION",
    effectActionDefinitionId: createEffectActionDefinitionId("ACT_RESET_CT"),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { targetSkillDefinitionId: targetSkillId, operation: "RESET" },
  };
}

function baseContext(
  recorder: EventRecorder,
  rootEventId: string,
  onFactEventForPassiveChain?: CooldownManipulationEventContext["onFactEventForPassiveChain"],
): CooldownManipulationEventContext {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    sourceUnitId: createBattleUnitId("ACTOR"),
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
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

describe("applyCooldownManipulationAction", () => {
  it("UT-R-SKL-09-005: a RESET that actually reduces remaining sets changed:true and emits CooldownReduced+CooldownCompleted", () => {
    const targetSkillId = createSkillDefinitionId("SKL_TARGET");
    const target = unit("ACTOR", targetSkillId);
    const action = resetAction(targetSkillId);
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const hit: ResolvedEffectApplication = {
      targetBattleUnitId: target.battleUnitId,
      effectActionDefinitionId: action.effectActionDefinitionId,
      hitIndex: 1,
    };

    const result = applyCooldownManipulationAction([hit], action, [target], context);

    expect(result.changed).toBe(true);
    expect(result.units[0]!.cooldowns[targetSkillId]?.remaining).toBe(0);
    const types = recorder.getEvents().map((e) => e.eventType);
    expect(types.filter((t) => t === "CooldownReduced")).toHaveLength(1);
    expect(types.filter((t) => t === "CooldownCompleted")).toHaveLength(1);
  });

  it("UT-R-SKL-09-006: a no-op manipulation (already READY) sets changed:false and emits no CooldownReduced/CooldownCompleted", () => {
    const targetSkillId = createSkillDefinitionId("SKL_TARGET");
    const target = unit("ACTOR", targetSkillId);
    const readyTarget: BattleUnit = { ...target, cooldowns: {} };
    const action = resetAction(targetSkillId);
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const hit: ResolvedEffectApplication = {
      targetBattleUnitId: readyTarget.battleUnitId,
      effectActionDefinitionId: action.effectActionDefinitionId,
      hitIndex: 1,
    };

    const before = recorder.getEvents().length;
    const result = applyCooldownManipulationAction([hit], action, [readyTarget], context);

    expect(result.changed).toBe(false);
    expect(recorder.getEvents().slice(before)).toHaveLength(0);
  });

  it("UT-R-SKL-06-012: onFactEventForPassiveChain is invoked after CooldownReduced/CooldownCompleted, and its returned units are threaded through", () => {
    const targetSkillId = createSkillDefinitionId("SKL_TARGET");
    const target = unit("ACTOR", targetSkillId);
    const action = resetAction(targetSkillId);
    const { recorder, rootEventId } = seedRecorder();
    const observed: string[] = [];
    const context = baseContext(recorder, rootEventId, (event, units) => {
      observed.push(event.eventType);
      return units;
    });
    const hit: ResolvedEffectApplication = {
      targetBattleUnitId: target.battleUnitId,
      effectActionDefinitionId: action.effectActionDefinitionId,
      hitIndex: 1,
    };

    applyCooldownManipulationAction([hit], action, [target], context);

    expect(observed).toEqual(["CooldownReduced", "CooldownCompleted"]);
  });
});
