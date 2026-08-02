import { describe, expect, it } from "vitest";
import {
  flattenEffectSequencePlan,
  resolveChargeReleaseOrder,
  resolveSkillOrder,
  type ActionStepPlan,
} from "./skill-resolution-service.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type {
  SkillDefinition,
  SkillResolutionDefinition,
} from "../../catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

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

/** TGT-004フェーズ2（Issue #167）: `statusKind: "STEALTH"`を持つ`AppliedEffect`。 */
function stealthEffect(targetId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_STEALTH_TEST");
  return {
    effectInstanceId: createEffectInstanceId(`ei-stealth-${targetId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: createBattleUnitId(targetId),
    targetId: createBattleUnitId(targetId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "STEALTH",
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
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
    counterUpdates: [],
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, enemy], effectActions),
    );

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, far, near], effectActions),
    );

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: tripleHit.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [tripleHit.effectActionDefinitionId, tripleHit],
    ]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, enemy], effectActions),
    );

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
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

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, enemy], effectActions),
    );

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [attack.effectActionDefinitionId, attack],
    ]);

    const fromOriginal = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, far, near], effectActions),
    );
    const fromShuffled = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [near, far, actor], effectActions),
    );

    expect(fromShuffled).toEqual(fromOriginal);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-001: a BRANCH step becomes a DeferredStepPlan carrying the raw definition (RES-003, Issue #217)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const branchStep = {
      kind: "BRANCH",
      condition: { kind: "TRUE" },
      thenSteps: [],
      elseSteps: [],
    } as const;
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [branchStep],
    });

    const plan = resolveSkillOrder(skill, actor, [actor], new Map());

    expect(plan.steps).toEqual([
      { planKind: "DEFERRED", stepIndex: 0, stepKind: "BRANCH", definition: branchStep },
    ]);
  });

  it("UT-R-SKL-07-001: RANDOM_BRANCH and REPEAT steps also become DeferredStepPlan entries", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const randomBranchStep = {
      kind: "RANDOM_BRANCH",
      mode: "WEIGHTED_ONE",
      branches: [{ weight: 1, steps: [] }],
    } as const;
    const repeatStep = { kind: "REPEAT", count: 2, steps: [] } as const;
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [randomBranchStep, repeatStep],
    });

    const plan = resolveSkillOrder(skill, actor, [actor], new Map());

    expect(plan.steps).toEqual([
      {
        planKind: "DEFERRED",
        stepIndex: 0,
        stepKind: "RANDOM_BRANCH",
        definition: randomBranchStep,
      },
      { planKind: "DEFERRED", stepIndex: 1, stepKind: "REPEAT", definition: repeatStep },
    ]);
  });

  it("UT-R-SKL-08-007: an ACTION step whose condition references LAST_RESULT becomes a DeferredStepPlan", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const actionStep = {
      kind: "ACTION",
      stepCondition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
      targetCondition: { kind: "TRUE" },
      target: { kind: "SELF" },
      actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
    } as const;
    const skill = skillOf({ kind: "IMMEDIATE", targetBindings: [], steps: [actionStep] });

    const plan = resolveSkillOrder(
      skill,
      actor,
      [actor],
      new Map([[attack.effectActionDefinitionId, attack]]),
    );

    expect(plan.steps).toEqual([
      { planKind: "DEFERRED", stepIndex: 0, stepKind: "ACTION", definition: actionStep },
    ]);
  });

  it("UT-R-SKL-08-008: an ACTION step targeting LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETS becomes a DeferredStepPlan", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    for (const targetKind of ["LAST_ACTION_TARGETS", "LAST_DAMAGED_TARGETS"] as const) {
      const actionStep = {
        kind: "ACTION",
        stepCondition: { kind: "TRUE" },
        targetCondition: { kind: "TRUE" },
        target: { kind: targetKind },
        actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
      } as const;
      const skill = skillOf({ kind: "IMMEDIATE", targetBindings: [], steps: [actionStep] });

      const plan = resolveSkillOrder(skill, actor, [actor], effectActions);

      expect(plan.steps).toEqual([
        { planKind: "DEFERRED", stepIndex: 0, stepKind: "ACTION", definition: actionStep },
      ]);
    }
  });

  it("UT-R-SKL-07-002: targetUnitIds includes structural SELF/BINDING candidates reachable inside deferred BRANCH/RANDOM_BRANCH/REPEAT subtrees, deduped in first-occurrence order", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const bindingTarget = {
      kind: "BINDING",
      targetBindingId: createTargetBindingId("TGT_1"),
    } as const;
    const actionOn = (target: typeof bindingTarget | { kind: "SELF" }) =>
      ({
        kind: "ACTION",
        stepCondition: { kind: "TRUE" },
        targetCondition: { kind: "TRUE" },
        target,
        actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
      }) as const;
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [actionOn(bindingTarget)],
          elseSteps: [actionOn({ kind: "SELF" })],
        },
        {
          kind: "RANDOM_BRANCH",
          mode: "INDEPENDENT",
          branches: [{ probability: 1, steps: [actionOn(bindingTarget)] }],
        },
        { kind: "REPEAT", count: 2, steps: [actionOn({ kind: "SELF" })] },
      ],
    });

    const plan = resolveSkillOrder(skill, actor, [actor, far, near], effectActions);

    expect(plan.targetUnitIds).toEqual([near.battleUnitId, far.battleUnitId, actor.battleUnitId]);
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: heal.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [heal.effectActionDefinitionId, heal],
    ]);

    const plan = flattenEffectSequencePlan(resolveSkillOrder(skill, actor, [actor], effectActions));

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
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
          stepCondition: { kind: "MARKER_PRESENT", markerId: "MARKER_X" } as never,
          targetCondition: { kind: "TRUE" },
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: missingActionId }],
        },
      ],
    });

    expect(() => resolveSkillOrder(skill, actor, [actor], new Map())).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-SKL-06-006: a step whose condition evaluates to false is skipped (empty applications, satisfied: false), and later steps still resolve", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const skipped = damageAction("ACT_SKIPPED");
    const resolved = damageAction("ACT_RESOLVED");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "NOT", condition: { kind: "TRUE" } },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: skipped.effectActionDefinitionId }],
        },
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: resolved.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [skipped.effectActionDefinitionId, skipped],
      [resolved.effectActionDefinitionId, resolved],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, enemy], effectActions);

    expect(plan.steps).toEqual([
      {
        planKind: "ACTION_PLAN",
        stepIndex: 0,
        stepKind: "ACTION",
        conditionKind: "NOT",
        satisfied: false,
        actions: [{ effectActionDefinitionId: skipped.effectActionDefinitionId }],
        applications: [],
      },
      {
        planKind: "ACTION_PLAN",
        stepIndex: 1,
        stepKind: "ACTION",
        conditionKind: "TRUE",
        satisfied: true,
        actions: [{ effectActionDefinitionId: resolved.effectActionDefinitionId }],
        applications: [
          {
            targetBattleUnitId: enemy.battleUnitId,
            effectActionDefinitionId: resolved.effectActionDefinitionId,
            includeDefeated: false,
            hits: [
              {
                targetBattleUnitId: enemy.battleUnitId,
                effectActionDefinitionId: resolved.effectActionDefinitionId,
                hitIndex: 1,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("UT-R-SKL-06-013/UT-R-ACTN-01-008 (R-ACTN-01 #2, PR #215 review finding [P2]): EffectActionApplication.includeDefeated carries the resolved TargetBinding's selector.includeDefeated, and a true selector keeps an already-defeated unit in the target pool", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const defeatedEnemy = unit(
      "ENEMY_DEFEATED",
      "ENEMY",
      { column: "LEFT", row: "FRONT" },
      { currentHp: 0 },
    );
    const attack = damageAction("ACT_ATTACK");
    const includeDefeatedSelector: TargetSelectorDefinition = {
      ...ENEMY_ALL_SELECTOR,
      includeDefeated: true,
    };
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: includeDefeatedSelector },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);

    const plan = resolveSkillOrder(skill, actor, [actor, defeatedEnemy], effectActions);

    expect((plan.steps[0] as ActionStepPlan).applications).toEqual([
      {
        targetBattleUnitId: defeatedEnemy.battleUnitId,
        effectActionDefinitionId: attack.effectActionDefinitionId,
        includeDefeated: true,
        hits: [
          {
            targetBattleUnitId: defeatedEnemy.battleUnitId,
            effectActionDefinitionId: attack.effectActionDefinitionId,
            hitIndex: 1,
          },
        ],
      },
    ]);
  });

  it("UT-R-SKL-06-007: plan.targetUnitIds dedupes targets across steps in first-occurrence order", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const near = unit("NEAR", "ENEMY", { column: "CENTER", row: "FRONT" });
    const far = unit("FAR", "ENEMY", { column: "LEFT", row: "BACK" });
    const first = damageAction("ACT_FIRST");
    const second = damageAction("ACT_SECOND");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: first.effectActionDefinitionId }],
        },
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: second.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map<EffectActionDefinitionId, EffectActionDefinition>([
      [first.effectActionDefinitionId, first],
      [second.effectActionDefinitionId, second],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, far, near], effectActions);

    expect(plan.targetUnitIds).toEqual([near.battleUnitId, far.battleUnitId]);
  });

  describe("TRIGGER_SOURCE/TRIGGER_TARGET (CAP_TRIGGER_CONTEXT, RES-005, Issue #172)", () => {
    it("UT-CAP-TRIGGER-CONTEXT-001: an ACTION step targeting TRIGGER_TARGET resolves to the triggerContext's target units", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const triggerTarget = unit("TRIGGER_TARGET_UNIT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const attack = damageAction("ACT_ATTACK");
      const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "TRIGGER_TARGET" },
            actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, triggerTarget], effectActions, {
        triggerTargetUnitIds: [triggerTarget.battleUnitId],
      });

      expect(flattenEffectSequencePlan(plan)).toEqual([
        {
          targetBattleUnitId: triggerTarget.battleUnitId,
          effectActionDefinitionId: attack.effectActionDefinitionId,
          hitIndex: 1,
        },
      ]);
    });

    it("UT-CAP-TRIGGER-CONTEXT-002: an ACTION step targeting TRIGGER_SOURCE resolves to the triggerContext's source unit", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const triggerSource = unit("TRIGGER_SOURCE_UNIT", "ENEMY", { column: "LEFT", row: "FRONT" });
      const attack = damageAction("ACT_ATTACK");
      const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "TRIGGER_SOURCE" },
            actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, triggerSource], effectActions, {
        triggerSourceUnitId: triggerSource.battleUnitId,
      });

      expect(flattenEffectSequencePlan(plan)).toEqual([
        {
          targetBattleUnitId: triggerSource.battleUnitId,
          effectActionDefinitionId: attack.effectActionDefinitionId,
          hitIndex: 1,
        },
      ]);
    });

    it("UT-CAP-TRIGGER-CONTEXT-003: an ACTION step targeting TRIGGER_TARGET/TRIGGER_SOURCE throws without a matching triggerContext", () => {
      const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
      const attack = damageAction("ACT_ATTACK");
      const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
      for (const targetKind of ["TRIGGER_TARGET", "TRIGGER_SOURCE"] as const) {
        const skill = skillOf({
          kind: "IMMEDIATE",
          targetBindings: [],
          steps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: targetKind },
              actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
            },
          ],
        });

        expect(() => resolveSkillOrder(skill, actor, [actor], effectActions)).toThrow(
          DomainValidationError,
        );
      }
    });
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: hit.effectActionDefinitionId }],
          },
        ],
      },
    });

    const plan = flattenEffectSequencePlan(
      resolveChargeReleaseOrder(skill, actor, [actor, enemy], effectActions),
    );

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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
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

describe("resolveSkillOrder: R-TGT-08 Stealth consumption plumbing (TGT-004, Issue #167, Phase 2: AppliedEffect-based)", () => {
  it("UT-SKILL-RESOLUTION-SERVICE-010: a targetBinding whose first-priority candidate holds Stealth surfaces a stealthConsumption on the plan, and resolves to the redirected candidate", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const nearestEnemy = unit(
      "NEAREST",
      "ENEMY",
      { column: "CENTER", row: "FRONT" },
      { appliedEffects: [stealthEffect("NEAREST")] },
    );
    const fartherEnemy = unit("FARTHER", "ENEMY", { column: "LEFT", row: "BACK" });
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
          selector: { ...ENEMY_ALL_SELECTOR, count: 1 },
        },
      ],
      steps: [],
    });

    const plan = resolveSkillOrder(skill, actor, [actor, nearestEnemy, fartherEnemy], new Map());

    expect(plan.stealthConsumptions).toEqual([
      {
        battleUnitId: createBattleUnitId("NEAREST"),
        effectInstanceId: createEffectInstanceId("ei-stealth-NEAREST"),
      },
    ]);
    expect(
      plan.resolvedBindings.get(createTargetBindingId("TGT_1"))!.units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("FARTHER")]);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-011: no Stealth holder means an empty stealthConsumptions array", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "CENTER", row: "FRONT" });
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [],
    });

    const plan = resolveSkillOrder(skill, actor, [actor, enemy], new Map());

    expect(plan.stealthConsumptions).toEqual([]);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-012 (R-TGT-10 definition order / R-TGT-08 #2 consume-on-first-priority): two targetBindings that both pick the same Stealth holder as first priority only redirect and consume once — the later binding sees the holder as no longer Stealthed", () => {
    const actor = unit("ACTOR", "ALLY", { column: "CENTER", row: "FRONT" });
    const nearestEnemy = unit(
      "NEAREST",
      "ENEMY",
      { column: "CENTER", row: "FRONT" },
      { appliedEffects: [stealthEffect("NEAREST")] },
    );
    const fartherEnemy = unit("FARTHER", "ENEMY", { column: "LEFT", row: "BACK" });
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
          selector: { ...ENEMY_ALL_SELECTOR, count: 1 },
        },
        {
          targetBindingId: createTargetBindingId("TGT_2"),
          selector: { ...ENEMY_ALL_SELECTOR, count: 1 },
        },
      ],
      steps: [],
    });

    const plan = resolveSkillOrder(skill, actor, [actor, nearestEnemy, fartherEnemy], new Map());

    expect(plan.stealthConsumptions).toEqual([
      {
        battleUnitId: createBattleUnitId("NEAREST"),
        effectInstanceId: createEffectInstanceId("ei-stealth-NEAREST"),
      },
    ]);
    expect(
      plan.resolvedBindings.get(createTargetBindingId("TGT_1"))!.units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("FARTHER")]);
    expect(
      plan.resolvedBindings.get(createTargetBindingId("TGT_2"))!.units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("NEAREST")]);
  });
});

describe("resolveSkillOrder: R-CFS-01 混乱の対象振り替え (DMG-009, Issue #193)", () => {
  /** 混乱（`APPLY_STATUS` の `CONFUSION`）を保持する`AppliedEffect`。 */
  function confusionEffect(targetId: string): AppliedEffect {
    const definitionId = createEffectActionDefinitionId("ACT_CONFUSION_TEST");
    return {
      effectInstanceId: createEffectInstanceId(`ei-confusion-${targetId}`),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceId: createBattleUnitId("SOURCE"),
      targetId: createBattleUnitId(targetId),
      magnitude: 0,
      categories: ["DEBUFF"],
      statusKind: "CONFUSION",
      statusDetails: { confusion: { damageReductionRate: 0.3, lowAttackBaseDamageRate: 0.1 } },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  const confusedActor = (): BattleUnit =>
    unit(
      "ACTOR",
      "ALLY",
      { column: "LEFT", row: "FRONT" },
      {
        appliedEffects: [confusionEffect("ACTOR")],
      },
    );

  const buffAction = (id: string): EffectActionDefinition => ({
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0.1 },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  });

  it("UT-R-CFS-01-001: an AS attack by a confused actor resolves its damage binding against the opposite side", () => {
    const actor = confusedActor();
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, ally, enemy], effectActions),
    );

    expect(plan.map((entry) => entry.targetBattleUnitId)).toEqual([
      createBattleUnitId("ACTOR"),
      createBattleUnitId("ALLY_1"),
    ]);
  });

  it("UT-R-CFS-01-002: the same skill used by an unconfused actor keeps its declared side", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
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
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, ally, enemy], effectActions),
    );

    expect(plan.map((entry) => entry.targetBattleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
  });

  it("UT-R-CFS-01-003: an EX skill is never redirected — R-CFS-01 limits the inversion to AS", () => {
    const actor = confusedActor();
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill: SkillDefinition = {
      ...skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          },
        ],
      }),
      skillType: "EX",
    };
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);

    const plan = flattenEffectSequencePlan(
      resolveSkillOrder(skill, actor, [actor, ally, enemy], effectActions),
    );

    expect(plan.map((entry) => entry.targetBattleUnitId)).toEqual([createBattleUnitId("ENEMY_1")]);
  });

  it("UT-R-CFS-01-004: a binding that no DAMAGE action targets keeps its declared side", () => {
    const actor = confusedActor();
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const buff = buffAction("ACT_BUFF");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_ATTACK"), selector: ENEMY_ALL_SELECTOR },
        {
          targetBindingId: createTargetBindingId("TGT_BUFF"),
          selector: { ...ENEMY_ALL_SELECTOR, side: "ALLY" },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ATTACK") },
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
        },
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_BUFF") },
          actions: [{ effectActionDefinitionId: buff.effectActionDefinitionId }],
        },
      ],
    });
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [buff.effectActionDefinitionId, buff],
    ]);

    const plan = resolveSkillOrder(skill, actor, [actor, ally, enemy], effectActions);

    expect(
      plan.resolvedBindings
        .get(createTargetBindingId("TGT_ATTACK"))!
        .units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")]);
    expect(
      plan.resolvedBindings
        .get(createTargetBindingId("TGT_BUFF"))!
        .units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")]);
  });

  it("UT-R-CFS-01-005: a DAMAGE action nested inside a BRANCH still inverts the binding it targets", () => {
    const actor = confusedActor();
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const attack = damageAction("ACT_ATTACK");
    const skill = skillOf({
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL_SELECTOR },
      ],
      steps: [
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              stepCondition: { kind: "TRUE" },
              targetCondition: { kind: "TRUE" },
              target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
              actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
            },
          ],
          elseSteps: [],
        },
      ],
    });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);

    const plan = resolveSkillOrder(skill, actor, [actor, ally, enemy], effectActions);

    expect(
      plan.resolvedBindings.get(createTargetBindingId("TGT_1"))!.units.map((u) => u.battleUnitId),
    ).toEqual([createBattleUnitId("ACTOR"), createBattleUnitId("ALLY_1")]);
  });

  it("UT-R-CFS-01-006: an AS charge release is inverted too — it is the same AS attack (R-SKL-05)", () => {
    const actor = confusedActor();
    const ally = unit("ALLY_1", "ALLY", { column: "CENTER", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const hit = damageAction("ACT_RELEASE_HIT");
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: hit.effectActionDefinitionId }],
          },
        ],
      },
    });
    const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);

    const plan = flattenEffectSequencePlan(
      resolveChargeReleaseOrder(skill, actor, [actor, ally, enemy], effectActions),
    );

    expect(plan.map((entry) => entry.targetBattleUnitId)).toEqual([
      createBattleUnitId("ACTOR"),
      createBattleUnitId("ALLY_1"),
    ]);
  });
});
