import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { EventRecorder } from "../events/event-recorder.js";
import {
  createActionId,
  createEffectInstanceId,
  createSkillUseId,
} from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
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
    currentHp?: number;
    maximumHp?: number;
    currentAp?: number;
    currentPp?: number;
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
      maximumHp: overrides.maximumHp ?? 100,
      attack: 10,
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
    currentHp: overrides.currentHp ?? built.currentHp,
    currentAp: overrides.currentAp ?? built.currentAp,
    currentPp: overrides.currentPp ?? built.currentPp,
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
      attack: 10,
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

function statusEffectAction(id: string, skillUseCount: number): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      status: "STEALTH",
      duration: {
        timeLimit: { unit: "SKILL_USE", count: skillUseCount },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/** A self-targeting AS skill that grants a SKILL_USE-duration status (e.g. Stealth) on the actor. */
function selfStatusSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
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
    metadata: { displayName: id, tags: [] },
  };
}

/** A trivial AS skill (attacks all enemies) used purely to complete a second skill use for the same actor. */
function trivialAttackSkill(id: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
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

/** An AS skill whose own EffectSequence declares an EFFECT_SEQUENCE-scoped counterUpdates (EFF-006/Issue #212). */
function asSkillWithCounterUpdates(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_AS_SEQ"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
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
            counter: "RUNTIME_COUNTER_AS_HITS",
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
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "AS", tags: [] },
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

describe("resolveSkillUse", () => {
  it("UT-R-EFF-11-025 (EFF-006 Issue #212): an AS skill's own EffectSequence counterUpdates increments during resolution and is discarded (RuntimeCounterReset) once resolveSkillUse completes", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_AS_HIT");
    const skill = asSkillWithCounterUpdates("ACT_AS_HIT");
    const hitCounterId = createRuntimeCounterId("RUNTIME_COUNTER_AS_HITS");

    const actor = unit("ACTOR", "ALLY", { unitDefinitionId: actorUnitDefinitionId, currentAp: 3 });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });

    const definitions = definitionsOf(
      new Map([
        [actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId)],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map(),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      actor,
      skill,
      "AS",
      "AS",
      [actor, enemy],
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
      ownerUnitId: actor.battleUnitId,
      counter: hitCounterId,
      skillDefinitionId: skill.skillDefinitionId,
      before: 0,
      after: 1,
    });

    const reset = events.filter(
      (e) =>
        e.eventType === "RuntimeCounterReset" &&
        (e.payload as { scope?: string }).scope === "EFFECT_SEQUENCE",
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]!.payload).toMatchObject({ skillDefinitionId: skill.skillDefinitionId });

    const actorAfter = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(actorAfter.effectSequenceCounters).toBeUndefined();
  });

  it("UT-R-EFF-01-047 (TGT-004フェーズ3、Issue #167、SKILL_USE単位期間減算の実配線): the AppliedEffect that grants a SKILL_USE(count:1) status is not decremented by its own granting skill use, but is decremented (and expires) by the actor's next completed skill use", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const grantAction = statusEffectAction("ACT_GRANT_STEALTH", 1);
    const grantSkill = selfStatusSkill("SKL_GRANT_STEALTH", "ACT_GRANT_STEALTH");
    const hit = damageEffectAction("ACT_HIT");
    const attackSkill = trivialAttackSkill("SKL_ATTACK", "ACT_HIT");

    const actor = unit("ACTOR", "ALLY", { unitDefinitionId: actorUnitDefinitionId, currentAp: 3 });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });

    const definitions = definitionsOf(
      new Map([
        [actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId)],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map(),
      new Map([
        [grantAction.effectActionDefinitionId, grantAction],
        [hit.effectActionDefinitionId, hit],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const grantResult = resolveSkillUse(
      actor,
      grantSkill,
      "AS",
      "AS",
      [actor, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const actorAfterGrant = grantResult.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(actorAfterGrant.appliedEffects).toHaveLength(1);
    expect(actorAfterGrant.appliedEffects[0]).toMatchObject({
      statusKind: "STEALTH",
    });
    // The granting skill use itself must not decrement its own instance.
    expect(actorAfterGrant.appliedEffects[0]!.duration.timeLimitRemaining).toBe(1);
    const eventsBeforeSecondUse = recorder.getEvents().length;

    const secondResult = resolveSkillUse(
      actorAfterGrant,
      attackSkill,
      "AS",
      "AS",
      grantResult.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    const actorAfterSecondUse = secondResult.units.find(
      (u) => u.battleUnitId === actor.battleUnitId,
    )!;
    expect(actorAfterSecondUse.appliedEffects).toHaveLength(0);

    const eventsFromSecondUse = recorder.getEvents().slice(eventsBeforeSecondUse);
    const reduced = eventsFromSecondUse.find((e) => e.eventType === "EffectDurationReduced");
    expect(reduced).toBeDefined();
    expect(reduced!.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      unit: "SKILL_USE",
      before: 1,
      after: 0,
    });
    const expired = eventsFromSecondUse.find((e) => e.eventType === "EffectExpired");
    expect(expired).toBeDefined();
    expect(expired!.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      reason: "TIME_LIMIT",
    });
    expect(eventsFromSecondUse.indexOf(reduced!)).toBeLessThan(
      eventsFromSecondUse.indexOf(expired!),
    );
  });

  it("UT-R-EFF-01-054 (TGT-004フェーズ3、Issue #167): a PS triggered by this very SkillUseCompleted that grants a fresh SKILL_USE(count:1) status is not immediately decremented/expired by the outer AS's own SKILL_USE decrement pass (the PS's grant carries its own distinct skillUseId, granted after the outer decrement already ran)", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR_REACTIVE_PS");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_REACTIVE_PS");
    const hit = damageEffectAction("ACT_HIT_REACTIVE");
    const attackSkill = trivialAttackSkill("SKL_ATTACK_REACTIVE", "ACT_HIT_REACTIVE");
    const grantAction = statusEffectAction("ACT_REACTIVE_PS_GRANT_STEALTH", 1);
    const reactivePs: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_REACTIVE_PS_GRANT_STEALTH"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "SkillUseCompleted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: grantAction.effectActionDefinitionId }],
          },
        ],
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
      metadata: { displayName: "ReactivePS", tags: [] },
    };

    // currentPp: createBattleUnit defaults PP to 0 (accumulates over the
    // battle, unlike AP), so the reactive PS (cost 1 PP) needs an explicit
    // starting balance to be able to afford activating.
    const actor = unit("ACTOR", "ALLY", {
      unitDefinitionId: actorUnitDefinitionId,
      currentAp: 3,
      currentPp: 3,
    });
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [
          actorUnitDefinitionId,
          unitDefinitionOf(actorUnitDefinitionId, [reactivePs.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map([[reactivePs.skillDefinitionId, reactivePs]]),
      new Map([
        [hit.effectActionDefinitionId, hit],
        [grantAction.effectActionDefinitionId, grantAction],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    const result = resolveSkillUse(
      actor,
      attackSkill,
      "AS",
      "AS",
      [actor, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const actorAfter = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(actorAfter.appliedEffects).toHaveLength(1);
    const granted = actorAfter.appliedEffects[0]!;
    expect(granted).toMatchObject({ statusKind: "STEALTH" });
    // The reactive PS's own grant must survive this same overall resolution
    // untouched — it must not be swept up by the outer AS's SKILL_USE
    // decrement pass, which uses a different (earlier) skillUseId.
    expect(granted.duration.timeLimitRemaining).toBe(1);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(false);
    expect(
      recorder
        .getEvents()
        .some(
          (e) =>
            e.eventType === "EffectDurationReduced" &&
            (e.payload as { effectInstanceId: string }).effectInstanceId ===
              granted.effectInstanceId,
        ),
    ).toBe(false);
  });

  it("UT-R-EFF-01-055 (TGT-004フェーズ3、Issue #167、08_ドメインイベント.md イベント発行と処理の順序契約): a PS reacting to SkillUseCompleted itself fully resolves before a PS reacting to the resulting EffectExpired, matching the events' own recorded (causal) order — not the reverse", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR_ORDER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_ORDER");
    const grantAction = statusEffectAction("ACT_GRANT_STEALTH_ORDER", 1);
    const hit = damageEffectAction("ACT_HIT_ORDER");
    const attackSkill = trivialAttackSkill("SKL_ATTACK_ORDER", "ACT_HIT_ORDER");

    // psOnCompletion reacts to this specific attack skill's own
    // SkillUseCompleted (not the earlier grant skill's).
    const psOnCompletion: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_COMPLETION"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "SkillUseCompleted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: attackSkill.skillDefinitionId,
          },
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
      metadata: { displayName: "PSOnCompletion", tags: [] },
    };
    const psOnExpiry: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_EXPIRY"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "EffectExpired",
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
      metadata: { displayName: "PSOnExpiry", tags: [] },
    };

    // Hand-built pre-existing SKILL_USE(count:1) effect (granted in a
    // different, earlier skillUseId than the attack skill below will use),
    // instead of an extra grant skill use, to keep PP within LIMITS.maximumPp.
    const preExisting: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect:pre-existing"),
      effectActionDefinitionId: grantAction.effectActionDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(grantAction.effectActionDefinitionId),
      duplicate: true,
      sourceId: createBattleUnitId("ACTOR"),
      targetId: createBattleUnitId("ACTOR"),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      duration: {
        definition: {
          timeLimit: { unit: "SKILL_USE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 1,
        grantedSkillUseId: createSkillUseId("B_1:skill-use:0"),
      },
      appliedTurnNumber: 1,
    };
    const actor = {
      ...unit("ACTOR", "ALLY", {
        unitDefinitionId: actorUnitDefinitionId,
        currentAp: 3,
        currentPp: 3,
      }),
      appliedEffects: [preExisting],
    };
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [
          actorUnitDefinitionId,
          unitDefinitionOf(actorUnitDefinitionId, [
            psOnCompletion.skillDefinitionId,
            psOnExpiry.skillDefinitionId,
          ]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map([
        [psOnCompletion.skillDefinitionId, psOnCompletion],
        [psOnExpiry.skillDefinitionId, psOnExpiry],
      ]),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const eventsBeforeAttack = recorder.getEvents().length;

    resolveSkillUse(
      actor,
      attackSkill,
      "AS",
      "AS",
      [actor, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const eventsFromAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const eventTypes = eventsFromAttack.map((e) => e.eventType);
    // Recorded (causal) order: SkillUseCompleted, then EffectDurationReduced,
    // then EffectExpired.
    expect(eventTypes.indexOf("SkillUseCompleted")).toBeLessThan(
      eventTypes.indexOf("EffectDurationReduced"),
    );
    expect(eventTypes.indexOf("EffectDurationReduced")).toBeLessThan(
      eventTypes.indexOf("EffectExpired"),
    );

    const completionActivated = eventsFromAttack.find(
      (e) =>
        e.eventType === "PassiveActivated" &&
        (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
          psOnCompletion.skillDefinitionId,
    );
    const expiryActivated = eventsFromAttack.find(
      (e) =>
        e.eventType === "PassiveActivated" &&
        (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
          psOnExpiry.skillDefinitionId,
    );
    expect(completionActivated).toBeDefined();
    expect(expiryActivated).toBeDefined();
    // Actual PS activation order must match the events' own recorded order
    // (SkillUseCompleted's own candidates resolve before its child duration
    // events'), not the reverse.
    expect(eventsFromAttack.indexOf(completionActivated!)).toBeLessThan(
      eventsFromAttack.indexOf(expiryActivated!),
    );
  });

  it("UT-R-EFF-01-057 (TGT-004フェーズ3、Issue #167): a SKILL_USE(count:2) effect decremented once by a reactive PS's own completion (nested within the outer AS's SkillUseCompleted chain) and once by the outer AS's own completion correctly reaches 0 via 2 -> 1 -> 0, recording 2 distinct EffectDurationReduced events for that transition instead of the second one clobbering the first with a stale snapshot value", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR_DOUBLE_DECREMENT");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_DOUBLE_DECREMENT");
    const grantAction = statusEffectAction("ACT_GRANT_STEALTH_DOUBLE_DECREMENT", 2);
    const hit = damageEffectAction("ACT_HIT_DOUBLE_DECREMENT");
    const attackSkill = trivialAttackSkill(
      "SKL_ATTACK_DOUBLE_DECREMENT",
      "ACT_HIT_DOUBLE_DECREMENT",
    );

    // The reactive PS reacts to the outer attack's own SkillUseCompleted and
    // has EMPTY steps, so its own PassiveResolved (a second, independent
    // "1 skill use completed" boundary for the same owner) fires immediately
    // within the outer SkillUseCompleted's chain and decrements the same
    // owner's SKILL_USE effects on its own.
    const reactivePs: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_DOUBLE_DECREMENT"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "SkillUseCompleted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: attackSkill.skillDefinitionId,
          },
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
      metadata: { displayName: "PSDoubleDecrement", tags: [] },
    };

    // Hand-built pre-existing SKILL_USE(count:2) effect (granted in a
    // different, earlier skillUseId than the attack skill below will use),
    // instead of an extra grant skill use, to keep PP within LIMITS.maximumPp.
    const preExisting: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect:pre-existing-double-decrement"),
      effectActionDefinitionId: grantAction.effectActionDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(grantAction.effectActionDefinitionId),
      duplicate: true,
      sourceId: createBattleUnitId("ACTOR"),
      targetId: createBattleUnitId("ACTOR"),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      duration: {
        definition: {
          timeLimit: { unit: "SKILL_USE", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
        grantedSkillUseId: createSkillUseId("B_1:skill-use:0"),
      },
      appliedTurnNumber: 1,
    };
    const actor = {
      ...unit("ACTOR", "ALLY", {
        unitDefinitionId: actorUnitDefinitionId,
        currentAp: 3,
        currentPp: 3,
      }),
      appliedEffects: [preExisting],
    };
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [
          actorUnitDefinitionId,
          unitDefinitionOf(actorUnitDefinitionId, [reactivePs.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map([[reactivePs.skillDefinitionId, reactivePs]]),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const eventsBeforeAttack = recorder.getEvents().length;

    const result = resolveSkillUse(
      actor,
      attackSkill,
      "AS",
      "AS",
      [actor, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const actorAfter = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(actorAfter.appliedEffects).toHaveLength(0);

    const eventsFromAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const reducedEvents = eventsFromAttack.filter((e) => e.eventType === "EffectDurationReduced");
    expect(reducedEvents).toHaveLength(2);
    expect(reducedEvents[0]!.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      effectInstanceId: preExisting.effectInstanceId,
      unit: "SKILL_USE",
      before: 2,
      after: 1,
    });
    expect(reducedEvents[1]!.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      effectInstanceId: preExisting.effectInstanceId,
      unit: "SKILL_USE",
      before: 1,
      after: 0,
    });

    const expiredEvents = eventsFromAttack.filter((e) => e.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0]!.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      effectInstanceId: preExisting.effectInstanceId,
      reason: "TIME_LIMIT",
    });
    expect(eventsFromAttack.indexOf(reducedEvents[1]!)).toBeLessThan(
      eventsFromAttack.indexOf(expiredEvents[0]!),
    );
  });

  it("UT-R-EFF-01-058 (TGT-004フェーズ3、Issue #167、08_ドメインイベント.md「現在処理中のイベントから直接発生したイベントを子とする」契約): the outer AS's own SKILL_USE decrement pass records its first EffectDurationReduced with parentEventId === skillUseCompleted.eventId, not the last event recorded by a PS chain that SkillUseCompleted happened to trigger in the meantime", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR_DECREMENT_PARENT");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY_DECREMENT_PARENT");
    const grantAction = statusEffectAction("ACT_GRANT_STEALTH_DECREMENT_PARENT", 2);
    const hit = damageEffectAction("ACT_HIT_DECREMENT_PARENT");
    const attackSkill = trivialAttackSkill(
      "SKL_ATTACK_DECREMENT_PARENT",
      "ACT_HIT_DECREMENT_PARENT",
    );

    // Same shape as UT-R-EFF-01-057 (a reactive PS with EMPTY steps, reacting
    // to the outer attack's own SkillUseCompleted, whose own PassiveResolved
    // independently decrements the same pre-existing SKILL_USE(count:2)
    // effect first) — here reused specifically because the PS's own
    // completion leaves an EffectDurationReduced as the LAST recorded event
    // before the outer AS's own decrement pass runs, which is exactly the
    // condition needed to expose a parentEventId mistakenly borrowed from
    // that trailing PS-chain event instead of skillUseCompleted itself.
    const reactivePs: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_DECREMENT_PARENT"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "SkillUseCompleted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "EVENT_PAYLOAD",
            field: "skillDefinitionId",
            op: "EQ",
            value: attackSkill.skillDefinitionId,
          },
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
      metadata: { displayName: "PSDecrementParent", tags: [] },
    };

    const preExisting: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("effect:pre-existing-decrement-parent"),
      effectActionDefinitionId: grantAction.effectActionDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(grantAction.effectActionDefinitionId),
      duplicate: true,
      sourceId: createBattleUnitId("ACTOR"),
      targetId: createBattleUnitId("ACTOR"),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      duration: {
        definition: {
          timeLimit: { unit: "SKILL_USE", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
        grantedSkillUseId: createSkillUseId("B_1:skill-use:0"),
      },
      appliedTurnNumber: 1,
    };
    const actor = {
      ...unit("ACTOR", "ALLY", {
        unitDefinitionId: actorUnitDefinitionId,
        currentAp: 3,
        currentPp: 3,
      }),
      appliedEffects: [preExisting],
    };
    const enemy = unit("ENEMY", "ENEMY", { unitDefinitionId: enemyUnitDefinitionId });
    const definitions = definitionsOf(
      new Map([
        [
          actorUnitDefinitionId,
          unitDefinitionOf(actorUnitDefinitionId, [reactivePs.skillDefinitionId]),
        ],
        [enemyUnitDefinitionId, unitDefinitionOf(enemyUnitDefinitionId)],
      ]),
      new Map([[reactivePs.skillDefinitionId, reactivePs]]),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const eventsBeforeAttack = recorder.getEvents().length;

    resolveSkillUse(
      actor,
      attackSkill,
      "AS",
      "AS",
      [actor, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const eventsFromAttack = recorder.getEvents().slice(eventsBeforeAttack);
    const skillUseCompleted = eventsFromAttack.find((e) => e.eventType === "SkillUseCompleted")!;
    const reducedEvents = eventsFromAttack.filter((e) => e.eventType === "EffectDurationReduced");
    expect(reducedEvents).toHaveLength(2);
    // reducedEvents[0] (2 -> 1) is from the reactive PS's own completion pass
    // and is the last event recorded before the outer AS's own decrement
    // pass runs. reducedEvents[1] (1 -> 0) is the outer AS's own decrement's
    // first (and only) EffectDurationReduced, and must be parented directly
    // on skillUseCompleted rather than on reducedEvents[0].
    expect(reducedEvents[1]!.parentEventId).toBe(skillUseCompleted.eventId);
    expect(reducedEvents[1]!.parentEventId).not.toBe(reducedEvents[0]!.eventId);
  });
});
