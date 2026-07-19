import { describe, expect, it } from "vitest";
import { detectPassiveCandidates } from "./passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard, recordActivation } from "./passive-activation-guard.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { EventSelector } from "./trigger-selector-evaluator.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

interface TriggerSpec {
  readonly eventType: string;
  readonly category: "FACT" | "TIMING";
  readonly sourceSelector: EventSelector;
  readonly targetSelector: EventSelector;
  readonly condition?: ConditionDefinition;
}

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  unitDefinitionId: UnitDefinitionId,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
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

function unitDefinitionOf(
  id: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[],
): UnitDefinition {
  return {
    unitDefinitionId: id,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds,
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: {
      displayName: "Test Unit",
      characterName: "Test Character",
      characterId: "CHAR_TEST",
      affiliations: [],
      tags: [],
    },
  };
}

function passiveSkillOf(
  id: string,
  trigger: TriggerSpec,
  activationCondition: ConditionDefinition = { kind: "TRUE" },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition,
    triggers: [
      {
        eventType: trigger.eventType,
        category: trigger.category,
        sourceSelector: trigger.sourceSelector,
        targetSelector: trigger.targetSelector,
        condition: trigger.condition ?? { kind: "TRUE" },
      },
    ],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

const UNIT_DEF_A = createUnitDefinitionId("UNIT_A");
const UNIT_DEF_B = createUnitDefinitionId("UNIT_B");

describe("detectPassiveCandidates", () => {
  it("UT-R-PS-01-020: matches candidates by eventType/category/selectors/condition without any per-eventType branching", () => {
    const skillTurn = passiveSkillOf("SKL_TURN", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const skillEffect = passiveSkillOf("SKL_EFFECT", {
      eventType: "EffectApplied",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [
        UNIT_DEF_A,
        unitDefinitionOf(UNIT_DEF_A, [skillTurn.skillDefinitionId, skillEffect.skillDefinitionId]),
      ],
    ]);
    const skillDefinitions = new Map([
      [skillTurn.skillDefinitionId, skillTurn],
      [skillEffect.skillDefinitionId, skillEffect],
    ]);

    const turnEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    const effectEvent: TriggerCandidateEvent = {
      eventType: "EffectApplied",
      category: "FACT",
      payload: { effectActionKind: "APPLY_STATUS", status: "FREEZE" },
    };

    const guard = createEmptyPassiveActivationGuard();
    const turnCandidates = detectPassiveCandidates({
      event: turnEvent,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    const effectCandidates = detectPassiveCandidates({
      event: effectEvent,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });

    expect(turnCandidates.map((c) => c.skillDefinition.skillDefinitionId)).toEqual([
      skillTurn.skillDefinitionId,
    ]);
    expect(effectCandidates.map((c) => c.skillDefinition.skillDefinitionId)).toEqual([
      skillEffect.skillDefinitionId,
    ]);
  });

  it("UT-R-PS-01-021: EVENT_PAYLOAD condition lets a PS react specifically to a freeze status granted via EffectApplied", () => {
    const freezeReactor = passiveSkillOf("SKL_FREEZE_REACT", {
      eventType: "EffectApplied",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "SELF",
      condition: { kind: "EVENT_PAYLOAD", field: "status", op: "EQ", value: "FREEZE" },
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [freezeReactor.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[freezeReactor.skillDefinitionId, freezeReactor]]);

    const freezeEvent: TriggerCandidateEvent = {
      eventType: "EffectApplied",
      category: "FACT",
      targetUnitIds: [owner.battleUnitId],
      payload: { effectActionKind: "APPLY_STATUS", status: "FREEZE" },
    };
    const stunEvent: TriggerCandidateEvent = {
      eventType: "EffectApplied",
      category: "FACT",
      targetUnitIds: [owner.battleUnitId],
      payload: { effectActionKind: "APPLY_STATUS", status: "STUN" },
    };

    const guard = createEmptyPassiveActivationGuard();
    expect(
      detectPassiveCandidates({
        event: freezeEvent,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(1);
    expect(
      detectPassiveCandidates({
        event: stunEvent,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(0);
  });

  it("UT-R-PS-01-022: multiple PS on the same unit are ordered by Catalog definition order", () => {
    const skillFirst = passiveSkillOf("SKL_FIRST", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const skillSecond = passiveSkillOf("SKL_SECOND", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [
        UNIT_DEF_A,
        unitDefinitionOf(UNIT_DEF_A, [skillFirst.skillDefinitionId, skillSecond.skillDefinitionId]),
      ],
    ]);
    const skillDefinitions = new Map([
      [skillFirst.skillDefinitionId, skillFirst],
      [skillSecond.skillDefinitionId, skillSecond],
    ]);

    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    const candidates = detectPassiveCandidates({
      event,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: createEmptyPassiveActivationGuard(),
    });

    expect(candidates.map((c) => c.skillDefinition.skillDefinitionId)).toEqual([
      skillFirst.skillDefinitionId,
      skillSecond.skillDefinitionId,
    ]);
  });

  it("UT-R-PS-01-023: a defeated owner's PS is never a candidate", () => {
    const skill = passiveSkillOf("SKL_A", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A, {
      currentHp: 0,
    });
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };

    expect(
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: createEmptyPassiveActivationGuard(),
      }),
    ).toHaveLength(0);
  });

  it("UT-R-PS-01-024: a charging owner's PS is excluded (チャージ中所有者のPS除外)", () => {
    const skill = passiveSkillOf("SKL_A", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const chargeSkill = passiveSkillOf("SKL_CHARGE_HOLDER", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A, {
      charge: { skill: chargeSkill, startedActionId: "ACTION_1" as never },
    });
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };

    expect(
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: createEmptyPassiveActivationGuard(),
      }),
    ).toHaveLength(0);
  });

  it("UT-R-PS-01-025 / R-PS-07: a PS already recorded as activated in the current scope is excluded (発動済みPS集合)", () => {
    const skill = passiveSkillOf("SKL_A", {
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
    });
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    const guard = recordActivation(
      createEmptyPassiveActivationGuard(),
      owner.battleUnitId,
      skill.skillDefinitionId,
    );

    expect(
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(0);
  });

  it("UT-R-PS-01-026 (regression): sourceSelector/targetSelector filter candidates across two units using only sourceUnitId, matching the shape production event-recorder.ts actually emits (sourceSide is never set)", () => {
    const allySourceSkill = passiveSkillOf("SKL_ALLY_SOURCE", {
      eventType: "DamageApplied",
      category: "FACT",
      sourceSelector: "ALLY",
      targetSelector: "ANY",
    });
    const allyOwner = unit("ALLY_OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const enemyOwner = unit("ENEMY_OWNER", "ENEMY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_B);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [allySourceSkill.skillDefinitionId])],
      [UNIT_DEF_B, unitDefinitionOf(UNIT_DEF_B, [allySourceSkill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[allySourceSkill.skillDefinitionId, allySourceSkill]]);
    const event: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: allyOwner.battleUnitId,
      payload: {},
    };

    const candidates = detectPassiveCandidates({
      event,
      units: [allyOwner, enemyOwner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: createEmptyPassiveActivationGuard(),
    });

    expect(candidates.map((c) => c.unit.battleUnitId)).toEqual([allyOwner.battleUnitId]);
  });

  it("UT-R-PS-01-030: a PS whose Skill activationCondition is not met is excluded even though its trigger matches", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const gatedSkill = passiveSkillOf(
      "SKL_GATED",
      { eventType: "TurnStarted", category: "FACT", sourceSelector: "ANY", targetSelector: "ANY" },
      { kind: "EVENT_PAYLOAD", field: "usable", op: "EQ", value: true },
    );
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [gatedSkill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[gatedSkill.skillDefinitionId, gatedSkill]]);

    const blockedEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: { usable: false },
    };
    const allowedEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: { usable: true },
    };
    const guard = createEmptyPassiveActivationGuard();

    expect(
      detectPassiveCandidates({
        event: blockedEvent,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(0);
    expect(
      detectPassiveCandidates({
        event: allowedEvent,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(1);
  });

  it("UT-R-PS-01-027: a reference to a missing UnitDefinition or SkillDefinition throws a clear DomainValidationError", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    expect(() =>
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions: new Map(),
        skillDefinitions: new Map(),
        activationGuard: createEmptyPassiveActivationGuard(),
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-PS-01-031 (Issue #144, TRIGGER_POSITION_RELATION): a POSITION_RELATION trigger condition only candidates when the target is directly in front of the owner", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "BACK" }, UNIT_DEF_A);
    const allyInFront = unit("IN_FRONT", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_B);
    const allyElsewhere = unit("ELSEWHERE", "ALLY", { column: "CENTER", row: "FRONT" }, UNIT_DEF_B);
    const skill = passiveSkillOf("SKL_GUARD", {
      eventType: "UnitBeingAttacked",
      category: "TIMING",
      sourceSelector: "ENEMY",
      targetSelector: "ALLY",
      condition: {
        kind: "POSITION_RELATION",
        target: { kind: "TRIGGER_TARGET" },
        relation: "IN_FRONT_OF",
      },
    });
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
      [UNIT_DEF_B, unitDefinitionOf(UNIT_DEF_B, [])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    const eventTargetingInFront: TriggerCandidateEvent = {
      eventType: "UnitBeingAttacked",
      category: "TIMING",
      sourceSide: "ENEMY",
      targetUnitIds: [allyInFront.battleUnitId],
      payload: {},
    };
    const eventTargetingElsewhere: TriggerCandidateEvent = {
      eventType: "UnitBeingAttacked",
      category: "TIMING",
      sourceSide: "ENEMY",
      targetUnitIds: [allyElsewhere.battleUnitId],
      payload: {},
    };

    expect(
      detectPassiveCandidates({
        event: eventTargetingInFront,
        units: [owner, allyInFront, allyElsewhere],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(1);
    expect(
      detectPassiveCandidates({
        event: eventTargetingElsewhere,
        units: [owner, allyInFront, allyElsewhere],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(0);
  });

  it("UT-R-PS-01-032 (Issue #144, TRIGGER_EXCLUSION_TIMING): a RESOLUTION_PHASE(negate: true) trigger condition excludes candidates only when the caller supplies the matching resolutionPhase", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_A);
    const skill = passiveSkillOf("SKL_EXCLUDED_AT_TURN_START", {
      eventType: "EffectApplied",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ENEMY",
      condition: { kind: "RESOLUTION_PHASE", phase: "TURN_START", negate: true },
    });
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
      [UNIT_DEF_B, unitDefinitionOf(UNIT_DEF_B, [])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);
    const target = unit("TARGET", "ENEMY", { column: "LEFT", row: "FRONT" }, UNIT_DEF_B);
    const event: TriggerCandidateEvent = {
      eventType: "EffectApplied",
      category: "FACT",
      targetUnitIds: [target.battleUnitId],
      payload: { category: "DEBUFF" },
    };
    const guard = createEmptyPassiveActivationGuard();

    expect(
      detectPassiveCandidates({
        event,
        units: [owner, target],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(1);
    expect(
      detectPassiveCandidates({
        event,
        units: [owner, target],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
        resolutionPhase: "TURN_START",
      }),
    ).toHaveLength(0);
  });
});
