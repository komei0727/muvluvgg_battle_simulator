import { describe, expect, it } from "vitest";
import { resolveChargeReleaseOrder, resolveSkillOrder } from "./skill-resolution-service.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createBattleUnitId } from "../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import type { SkillDefinition, SkillResolutionDefinition } from "../catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import { DomainValidationError } from "../shared/errors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
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

function damageAction(id: string, hitCount = 1): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "CONSTANT", value: 10 },
      hitCount,
      critical: { mode: "NORMAL" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function skillOf(resolution: SkillResolutionDefinition): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution,
    cooldown: { unit: "ACTION", count: 0 },
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

const ENEMY_ALL_SELECTOR: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

describe("resolveSkillOrder", () => {
  it("UT-R-SKL-01-001: a single target and single action resolves to one entry", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, enemy], effectActions);

    expect(plan).toEqual([
      {
        targetBattleUnitId: createBattleUnitId("ENEMY_1"),
        effectActionDefinitionId: attack.effectActionDefinitionId,
        hitIndex: 1,
      },
    ]);
  });

  it("UT-R-SKL-02-001: multiple targets resolve target-major, in TargetSelectionPolicy order", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, far, near], effectActions);

    expect(plan.map((entry) => entry.targetBattleUnitId)).toEqual([
      createBattleUnitId("NEAR"),
      createBattleUnitId("FAR"),
    ]);
  });

  it("UT-R-SKL-03-001: a single target with hitCount 3 resolves three independently ordered hits", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const tripleHit = damageAction("ACT_TRIPLE", 3);
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: tripleHit.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [tripleHit.effectActionDefinitionId, tripleHit],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, enemy], effectActions);

    expect(plan.map((entry) => entry.hitIndex)).toEqual([1, 2, 3]);
    expect(plan.every((entry) => entry.targetBattleUnitId === createBattleUnitId("ENEMY_1"))).toBe(
      true,
    );
  });

  it("UT-R-SKL-01-002: multiple actions on one target resolve in definition order, hits nested within each action", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const first = damageAction("ACT_FIRST", 2);
    const second = damageAction("ACT_SECOND", 1);
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [
            { effectActionDefinitionId: first.effectActionDefinitionId },
            { effectActionDefinitionId: second.effectActionDefinitionId },
          ],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [first.effectActionDefinitionId, first],
      [second.effectActionDefinitionId, second],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, enemy], effectActions);

    expect(plan.map((entry) => [entry.effectActionDefinitionId, entry.hitIndex] as const)).toEqual([
      [first.effectActionDefinitionId, 1],
      [first.effectActionDefinitionId, 2],
      [second.effectActionDefinitionId, 1],
    ]);
  });

  it("UT-R-SKL-01-003: input array order does not affect the resolved order (determinism)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const fromOriginal = resolveSkillOrder(skill, actor, [actor, far, near], effectActions);
    const fromShuffled = resolveSkillOrder(skill, actor, [near, far, actor], effectActions);

    expect(fromShuffled).toEqual(fromOriginal);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-001: throws for a BRANCH step (only ACTION steps are supported by this basic SkillResolutionService)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [{ kind: "BRANCH", condition: { kind: "TRUE" }, thenSteps: [], elseSteps: [] }],
    });

    expect(() => resolveSkillOrder(skill, actor, [actor], new Map())).toThrow(
      DomainValidationError,
    );
  });

  it("UT-SKILL-RESOLUTION-SERVICE-002: throws for a CHARGE skill (charge behavior is out of scope for this basic SkillResolutionService)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const skill = skillOf({
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: { targetBindings: [], steps: [] },
    });

    expect(() => resolveSkillOrder(skill, actor, [actor], new Map())).toThrow(
      DomainValidationError,
    );
  });

  it("UT-SKILL-RESOLUTION-SERVICE-003: a SELF target reference resolves to the actor without a binding", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const heal = damageAction("ACT_SELF_HEAL");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: heal.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [heal.effectActionDefinitionId, heal],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor], effectActions);

    expect(plan).toEqual([
      {
        targetBattleUnitId: createBattleUnitId("ACTOR"),
        effectActionDefinitionId: heal.effectActionDefinitionId,
        hitIndex: 1,
      },
    ]);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-004: throws for an unsupported target reference kind (TRIGGER_SOURCE/TRIGGER_TARGET/etc. are M6/M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "TRIGGER_SOURCE" },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    expect(() => resolveSkillOrder(skill, actor, [actor], effectActions)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-SKILL-RESOLUTION-SERVICE-005: throws when a BINDING target reference names an unresolved targetBindingId (defensive)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_MISSING") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    expect(() => resolveSkillOrder(skill, actor, [actor], effectActions)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-SKILL-RESOLUTION-SERVICE-006: throws for a step with a non-TRUE condition instead of silently ignoring it (ConditionEvaluator is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "MARKER_PRESENT", markerId: "MARKER_X" } as never,
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    expect(() => resolveSkillOrder(skill, actor, [actor], effectActions)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-SKILL-RESOLUTION-SERVICE-007: throws when an action references an EffectActionDefinitionId absent from effectActions, instead of treating it as one successful hit (defensive; Catalog preflight should already guarantee this)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const missingActionId = createEffectActionDefinitionId("ACT_MISSING");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: missingActionId }],
        },
      ],
    });

    expect(() => resolveSkillOrder(skill, actor, [actor], new Map())).toThrow(
      DomainValidationError,
    );
  });
});

describe("resolveChargeReleaseOrder", () => {
  it("UT-SKILL-RESOLUTION-SERVICE-008 (R-SKL-05): resolves the chargeRelease EffectSequence's targetBindings and steps, independently of the CHARGE resolution's own (unused) steps", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const hit = damageAction("ACT_RELEASE_HIT");
    const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);
    const skill = skillOf({
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
        ],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: hit.effectActionDefinitionId }],
          },
        ],
      },
    });

    const plan = resolveChargeReleaseOrder(skill, actor, [actor, enemy], effectActions);

    expect(plan).toEqual([
      {
        targetBattleUnitId: enemy.battleUnitId,
        effectActionDefinitionId: hit.effectActionDefinitionId,
        hitIndex: 1,
      },
    ]);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-009: throws for an IMMEDIATE skill (chargeRelease only exists on CHARGE resolution)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          condition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId("ACT_NOOP") }],
        },
      ],
    });

    expect(() => resolveChargeReleaseOrder(skill, actor, [actor], new Map())).toThrow(
      DomainValidationError,
    );
  });
});
