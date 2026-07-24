import { describe, expect, it } from "vitest";
import { resolveChargeRelease } from "./action-charge-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createActionId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { createRuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(
  id: string,
  side: Side,
  overrides: {
    unitDefinitionId?: UnitDefinitionId;
    currentPp?: number;
    currentHp?: number;
    charge?: BattleUnit["charge"];
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: overrides.unitDefinitionId ?? createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, side, LIMITS);
  return {
    ...built,
    currentPp: overrides.currentPp ?? built.currentPp,
    currentHp: overrides.currentHp ?? built.currentHp,
    ...(overrides.charge !== undefined ? { charge: overrides.charge } : {}),
  };
}

function unitDefinitionOf(
  id: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[] = [],
): UnitDefinition {
  return {
    unitDefinitionId: id,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 10,
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

function damageEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function chargeReleaseSkill(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_CHARGE"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
          },
        ],
      },
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Charge", tags: [] },
  };
}

/** Same as `chargeReleaseSkill` but the `chargeRelease` EffectSequence also declares an EFFECT_SEQUENCE-scoped counterUpdates (EFF-006/Issue #212). */
function chargeReleaseSkillWithCounterUpdates(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_CHARGE"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
          },
        ],
        counterUpdates: [
          createRuntimeCounterUpdateDefinition(
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_CHARGE_HITS",
              scope: "EFFECT_SEQUENCE",
              trigger: {
                eventType: "EffectActionCompleted",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ANY",
              },
              amount: 1,
            },
            "counterUpdates[0]",
          ),
        ],
      },
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Charge", tags: [] },
  };
}

/** Same as `chargeReleaseSkillWithCounterUpdates` but the counterUpdates trigger is `ChargeReleased` itself (PR #213 review [P2]), not an event emitted during effect resolution. */
function chargeReleaseSkillWithChargeReleasedCounterUpdates(
  effectActionId: string,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_CHARGE"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
          },
        ],
        counterUpdates: [
          createRuntimeCounterUpdateDefinition(
            {
              kind: "INCREMENT",
              counter: "RUNTIME_COUNTER_CHARGE_RELEASED",
              scope: "EFFECT_SEQUENCE",
              trigger: {
                eventType: "ChargeReleased",
                category: "FACT",
                sourceSelector: "SELF",
                targetSelector: "ANY",
              },
              amount: 1,
            },
            "counterUpdates[0]",
          ),
        ],
      },
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Charge", tags: [] },
  };
}

/** trigger on any `DamageApplied`, with a trivial (empty-steps) resolution — only whether it activates at all matters for this test. */
function passiveSkillOnDamageApplied(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType: "DamageApplied",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
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

function definitionsOf(
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<
    ReturnType<typeof createEffectActionDefinitionId>,
    EffectActionDefinition
  >,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions,
    skillDefinitions,
  };
}

describe("resolveChargeRelease", () => {
  it("PR #142レビュー[P1]: a PS triggered by the charge release's own DamageApplied activates (PassiveActivationRuntime was previously never wired for charge release)", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const psOwnerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_CHARGE_HIT");
    const psSkill = passiveSkillOnDamageApplied("SKL_PS");
    const chargeSkill = chargeReleaseSkill("ACT_CHARGE_HIT");

    const charger = unit("CHARGER", "ALLY", {
      unitDefinitionId: chargerUnitDefinitionId,
      charge: { skill: chargeSkill, startedActionId: createActionId("B_1:action:0") },
    });
    const psOwner = unit("PS_OWNER", "ALLY", {
      unitDefinitionId: psOwnerUnitDefinitionId,
      currentPp: 3,
    });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });

    const definitions = definitionsOf(
      new Map([
        [chargerUnitDefinitionId, unitDefinitionOf(chargerUnitDefinitionId)],
        [
          psOwnerUnitDefinitionId,
          unitDefinitionOf(psOwnerUnitDefinitionId, [psSkill.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map([[psSkill.skillDefinitionId, psSkill]]),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveChargeRelease(
      charger,
      "AS",
      [charger, psOwner, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "DamageApplied")).toBe(true);
    const passiveActivated = events.find(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === psOwner.battleUnitId,
    );
    expect(passiveActivated).toBeDefined();
    expect(passiveActivated?.payload).toMatchObject({
      actorUnitId: psOwner.battleUnitId,
      skillDefinitionId: psSkill.skillDefinitionId,
    });
    expect(
      events.some(
        (e) => e.eventType === "PassiveResolved" && e.sourceUnitId === psOwner.battleUnitId,
      ),
    ).toBe(true);

    const psOwnerAfter = result.units.find((u) => u.battleUnitId === psOwner.battleUnitId)!;
    expect(psOwnerAfter.currentPp).toBe(2);
  });

  it("UT-R-EFF-11-024 (EFF-006 Issue #212): a chargeRelease EffectSequence's own EFFECT_SEQUENCE counterUpdates increments during resolution and is discarded (RuntimeCounterReset) once resolveChargeRelease completes", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_CHARGE_HIT");
    const chargeSkill = chargeReleaseSkillWithCounterUpdates("ACT_CHARGE_HIT");
    const hitCounterId = createRuntimeCounterId("RUNTIME_COUNTER_CHARGE_HITS");

    const charger = unit("CHARGER", "ALLY", {
      unitDefinitionId: chargerUnitDefinitionId,
      charge: { skill: chargeSkill, startedActionId: createActionId("B_1:action:0") },
    });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });

    const definitions = definitionsOf(
      new Map([
        [chargerUnitDefinitionId, unitDefinitionOf(chargerUnitDefinitionId)],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map(),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveChargeRelease(
      charger,
      "AS",
      [charger, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    const changed = events.filter(
      (e) =>
        e.eventType === "RuntimeCounterChanged" &&
        (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      ownerUnitId: charger.battleUnitId,
      counter: hitCounterId,
      skillDefinitionId: chargeSkill.skillDefinitionId,
      before: 0,
      after: 1,
    });

    const reset = events.filter(
      (e) =>
        e.eventType === "RuntimeCounterReset" &&
        (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]!.payload).toMatchObject({ skillDefinitionId: chargeSkill.skillDefinitionId });

    const chargerAfter = result.units.find((u) => u.battleUnitId === charger.battleUnitId)!;
    expect(chargerAfter.effectSequenceCounters).toBeUndefined();
  });

  it("UT-R-EFF-11-026 (PR #213 review [P2]): a chargeRelease counterUpdates trigger on ChargeReleased itself increments, because ChargeReleased is routed through the active EffectSequence resolution before effect resolution begins", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_CHARGE_HIT");
    const chargeSkill = chargeReleaseSkillWithChargeReleasedCounterUpdates("ACT_CHARGE_HIT");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_CHARGE_RELEASED");

    const charger = unit("CHARGER", "ALLY", {
      unitDefinitionId: chargerUnitDefinitionId,
      charge: { skill: chargeSkill, startedActionId: createActionId("B_1:action:0") },
    });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });

    const definitions = definitionsOf(
      new Map([
        [chargerUnitDefinitionId, unitDefinitionOf(chargerUnitDefinitionId)],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map(),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    resolveChargeRelease(
      charger,
      "AS",
      [charger, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    const changed = events.filter(
      (e) =>
        e.eventType === "RuntimeCounterChanged" &&
        (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      counter: counterId,
      skillDefinitionId: chargeSkill.skillDefinitionId,
      before: 0,
      after: 1,
    });
  });
});
