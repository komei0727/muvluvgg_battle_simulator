import { describe, expect, it } from "vitest";
import { reconfirmPassiveCandidate } from "./reconfirm-passive-candidate.js";
import { createEmptyPassiveActivationGuard, recordActivation } from "./passive-activation-guard.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import { startCooldown } from "../model/cooldown-state.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const POSITION = { column: "LEFT", row: "FRONT" } as const;

function owner(side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId("OWNER"),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position: POSITION,
    globalCoordinate: toGlobalCoordinate(side, POSITION),
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
  return { ...createBattleUnit(member, side, LIMITS), currentPp: 3, ...overrides };
}

interface SkillOverrides {
  readonly amount?: number;
  readonly activationCondition?: ConditionDefinition;
}

function skillOf(overrides: SkillOverrides = {}): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_A"),
    skillType: "PS",
    cost: { resource: "PP", amount: overrides.amount ?? 1 },
    activationCondition: overrides.activationCondition ?? { kind: "TRUE" },
    triggers: [
      {
        eventType: "TurnStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "EVENT_PAYLOAD", field: "ready", op: "EQ", value: true },
      },
    ],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 2 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Test", tags: [] },
  };
}

function candidateOf(unit: BattleUnit, skill: SkillDefinition): PassiveCandidate {
  const trigger = skill.triggers[0];
  if (trigger === undefined) {
    throw new Error("test skill must declare at least one trigger");
  }
  return { unit, skillDefinition: skill, trigger, definitionIndex: 0 };
}

const READY_EVENT: TriggerCandidateEvent = {
  eventType: "TurnStarted",
  category: "FACT",
  payload: { ready: true },
};

describe("reconfirmPassiveCandidate", () => {
  it("UT-R-PS-04-001: a still-valid candidate is confirmed", () => {
    const unit = owner("ALLY");
    const candidate = candidateOf(unit, skillOf());
    expect(
      reconfirmPassiveCandidate(candidate, unit, READY_EVENT, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: true });
  });

  it("UT-R-PS-04-002: a defeated owner discards the candidate with reason OWNER_DEFEATED (所有者が戦闘可能でない)", () => {
    const unit = owner("ALLY", { currentHp: 0 });
    const candidate = candidateOf(unit, skillOf());
    expect(
      reconfirmPassiveCandidate(candidate, unit, READY_EVENT, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: false, reason: "OWNER_DEFEATED" });
  });

  it("UT-R-PS-04-003: a charging owner discards the candidate with reason OWNER_CHARGING (チャージ中)", () => {
    const chargeSkill = skillOf();
    const unit = owner("ALLY", {
      charge: { skill: chargeSkill, startedActionId: "ACTION_1" as never },
    });
    const candidate = candidateOf(unit, skillOf());
    expect(
      reconfirmPassiveCandidate(candidate, unit, READY_EVENT, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: false, reason: "OWNER_CHARGING" });
  });

  it("UT-R-PS-04-004: insufficient PP discards the candidate with reason INSUFFICIENT_PP", () => {
    const unit = owner("ALLY", { currentPp: 0 });
    const candidate = candidateOf(unit, skillOf({ amount: 1 }));
    expect(
      reconfirmPassiveCandidate(candidate, unit, READY_EVENT, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: false, reason: "INSUFFICIENT_PP" });
  });

  it("UT-R-PS-04-005: a positive cooldown remaining discards the candidate with reason COOLING_DOWN", () => {
    const skill = skillOf();
    const unit = owner("ALLY");
    const { cooldowns } = startCooldown(unit.cooldowns, skill.skillDefinitionId, skill.cooldown, {
      actionId: "OTHER_ACTION" as never,
    });
    const cooling = { ...unit, cooldowns };
    const candidate = candidateOf(cooling, skill);
    expect(
      reconfirmPassiveCandidate(
        candidate,
        cooling,
        READY_EVENT,
        createEmptyPassiveActivationGuard(),
      ),
    ).toEqual({ ok: false, reason: "COOLING_DOWN" });
  });

  it("UT-R-PS-04-006: a trigger condition that no longer holds discards the candidate with reason CONDITION_NOT_MET (条件変化)", () => {
    const unit = owner("ALLY");
    const candidate = candidateOf(unit, skillOf());
    const staleEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: { ready: false },
    };
    expect(
      reconfirmPassiveCandidate(candidate, unit, staleEvent, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: false, reason: "CONDITION_NOT_MET" });
  });

  it("UT-R-PS-04-008: a Skill activationCondition that no longer holds discards the candidate with reason CONDITION_NOT_MET, even though the trigger condition still holds", () => {
    const unit = owner("ALLY");
    const skill = skillOf({
      activationCondition: { kind: "EVENT_PAYLOAD", field: "usable", op: "EQ", value: true },
    });
    const candidate = candidateOf(unit, skill);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: { ready: true, usable: false },
    };
    expect(
      reconfirmPassiveCandidate(candidate, unit, event, createEmptyPassiveActivationGuard()),
    ).toEqual({ ok: false, reason: "CONDITION_NOT_MET" });
  });

  it("UT-R-PS-04-007 / R-PS-07: already-activated-in-scope discards the candidate with reason ALREADY_ACTIVATED", () => {
    const skill = skillOf();
    const unit = owner("ALLY");
    const candidate = candidateOf(unit, skill);
    const guard = recordActivation(
      createEmptyPassiveActivationGuard(),
      unit.battleUnitId,
      skill.skillDefinitionId,
    );
    expect(reconfirmPassiveCandidate(candidate, unit, READY_EVENT, guard)).toEqual({
      ok: false,
      reason: "ALREADY_ACTIVATED",
    });
  });
});
