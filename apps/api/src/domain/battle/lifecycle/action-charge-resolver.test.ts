import { describe, expect, it } from "vitest";
import { resolveChargeRelease } from "./action-charge-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { EventRecorder } from "../events/event-recorder.js";
import { reduceStateDeltas } from "./state-delta-reducer.js";
import { initialSnapshotFor } from "../../../testing/fixtures/index.js";
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
    category: "PLAYABLE",
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
    metadata: { displayName: "Charge", tags: [] },
  };
}

/** Same as `chargeReleaseSkillWithCounterUpdates` but the counterUpdates trigger is `ChargeReleased` itself, not an event emitted during effect resolution. */
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
    metadata: { displayName: id, tags: [] },
  };
}

/** 1ヒットで使用者自身を確実に倒す自傷DAMAGE（`unit()`の最大HP100・防御10に対し威力十分）。 */
function selfDestructEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "CONSTANT", value: 1000 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 1, shieldIgnoreRate: 1, damageReductionIgnoreRate: 1 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/**
 * 1つ目のstepで自分を倒し、2つ目のstepが未解決のまま残るチャージ解放スキル。
 * `EffectSequenceOutcome.status` を `INTERRUPTED` にするための最小構成。
 */
function selfDestructChargeReleaseSkill(
  selfDamageActionId: string,
  enemyDamageActionId: string,
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
            target: { kind: "SELF" },
            actions: [
              { effectActionDefinitionId: createEffectActionDefinitionId(selfDamageActionId) },
            ],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [
              { effectActionDefinitionId: createEffectActionDefinitionId(enemyDamageActionId) },
            ],
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
    metadata: { displayName: "Charge", tags: [] },
  };
}

/** `ChargeReleaseCompleted` を契機に持つPS。中断時に候補化されないことの確認用。 */
function passiveSkillOnChargeReleaseCompleted(id: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType: "ChargeReleaseCompleted",
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
    metadata: { displayName: id, tags: [] },
  };
}

/** 1行動の気絶を付与する `APPLY_STATUS`。解放中のSTUN（R-STS-02）の再現用。 */
function stunEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      status: "STUN",
      duration: {
        timeLimit: { unit: "ACTION", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      probability: 1,
    },
  };
}

/** `DamageApplied` を契機に、攻撃してきた相手（`TRIGGER_SOURCE`）へ気絶を付与するPS。 */
function passiveStunningTheAttacker(id: string, stunActionId: string): SkillDefinition {
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
        targetSelector: "SELF",
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
          target: { kind: "TRIGGER_SOURCE" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(stunActionId) }],
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
  it("a PS triggered by the charge release's own DamageApplied activates (PassiveActivationRuntime was previously never wired for charge release)", () => {
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

  it("UT-R-EFF-11-026: a chargeRelease counterUpdates trigger on ChargeReleased itself increments, because ChargeReleased is routed through the active EffectSequence resolution before effect resolution begins", () => {
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

  it("the charge termination StateDelta belongs to ChargeReleaseCompleted, so replaying deltas up to that event already shows the charge as ended (it is not deferred to ActionCompleting)", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_CHARGE_HIT");
    const chargeSkill = chargeReleaseSkill("ACT_CHARGE_HIT");
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
    const completedIndex = events.findIndex((e) => e.eventType === "ChargeReleaseCompleted");
    expect(completedIndex).toBeGreaterThanOrEqual(0);

    // 契機イベントまでの公開差分だけを当て直した時点で、既にチャージは終わっている。
    const upToCompleted = reduceStateDeltas(
      initialSnapshotFor([charger, enemy], { include: ["effects", "markers", "charge"] }),
      events
        .slice(0, completedIndex + 1)
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(upToCompleted.units[charger.battleUnitId]?.charge).toBeUndefined();

    // 二重適用防止: チャージ終了差分を持つイベントはこの1件だけで、
    // `ActionCompleting` はもう所有していない。
    const chargeDeltaOwners = events.filter(
      (event) => event.stateDelta?.units?.[charger.battleUnitId]?.charge !== undefined,
    );
    expect(chargeDeltaOwners.map((event) => event.eventType)).toEqual(["ChargeReleaseCompleted"]);
  });

  it("a charge release interrupted by the actor's own death emits ChargeReleaseInterrupted (not ChargeReleaseCompleted), and a PS triggered by ChargeReleaseCompleted is never a candidate", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const psOwnerUnitDefinitionId = createUnitDefinitionId("UNIT_PS_OWNER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const selfDamage = selfDestructEffectAction("ACT_SELF_DAMAGE");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE");
    const psSkill = passiveSkillOnChargeReleaseCompleted("SKL_PS_ON_RELEASE");
    const chargeSkill = selfDestructChargeReleaseSkill("ACT_SELF_DAMAGE", "ACT_ENEMY_DAMAGE");

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
      new Map([
        [selfDamage.effectActionDefinitionId, selfDamage],
        [enemyDamage.effectActionDefinitionId, enemyDamage],
      ]),
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
    expect(events.some((e) => e.eventType === "ChargeReleaseCompleted")).toBe(false);
    const interrupted = events.find((e) => e.eventType === "ChargeReleaseInterrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload).toMatchObject({
      actorUnitId: charger.battleUnitId,
      skillDefinitionId: chargeSkill.skillDefinitionId,
      reason: "ACTOR_DEFEATED",
    });

    // 未完了の解放は「攻撃した後」のPSの契機にならない。
    expect(events.some((e) => e.eventType === "PassiveActivated")).toBe(false);
    expect(result.units.find((u) => u.battleUnitId === psOwner.battleUnitId)!.currentPp).toBe(3);

    // 中断でもチャージ状態は終わり、その差分は中断イベントが所有する。
    expect(
      result.units.find((u) => u.battleUnitId === charger.battleUnitId)!.charge,
    ).toBeUndefined();
    expect(
      events
        .filter((event) => event.stateDelta?.units?.[charger.battleUnitId]?.charge !== undefined)
        .map((event) => event.eventType),
    ).toEqual(["ChargeReleaseInterrupted"]);
  });

  it("UT-R-ATM-01-007 (R-STS-02/R-SKL-05): the counter-attacking PS that STUNs the releasing actor is held back to the post phase, so the charge is already closed by the finishing event — no second removal is emitted and an independent Reducer replays every StateDelta cleanly", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_CHARGE_HIT");
    const stun = stunEffectAction("ACT_STUN_BACK");
    const psSkill = passiveStunningTheAttacker("SKL_PS_STUN_BACK", "ACT_STUN_BACK");
    const chargeSkill = chargeReleaseSkill("ACT_CHARGE_HIT");

    const charger = unit("CHARGER", "ALLY", {
      unitDefinitionId: chargerUnitDefinitionId,
      charge: { skill: chargeSkill, startedActionId: createActionId("B_1:action:0") },
    });
    // 解放攻撃を受けた敵が反撃としてチャージ中のactorへ気絶を付与する。
    const enemy = unit("ENEMY", "ENEMY", {
      unitDefinitionId: enemyUnitDefinitionId,
      currentPp: 3,
    });
    const definitions = definitionsOf(
      new Map([
        [chargerUnitDefinitionId, unitDefinitionOf(chargerUnitDefinitionId)],
        [
          enemyUnitDefinitionId,
          unitDefinitionOf(enemyUnitDefinitionId, [psSkill.skillDefinitionId]),
        ],
      ]),
      new Map([[psSkill.skillDefinitionId, psSkill]]),
      new Map([
        [hit.effectActionDefinitionId, hit],
        [stun.effectActionDefinitionId, stun],
      ]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));
    const initialSnapshot = initialSnapshotFor([charger, enemy], {
      include: ["effects", "markers", "charge"],
    });

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
    // R-ATM-01: 反撃PSの発動は効果処理の完了後（`ChargeReleaseCompleted`の発行後）に
    // なる。その時点でチャージ状態は既に終了しているため、解放中のSTUNを表す
    // `cancelChargeOnStun`（`ChargeCancelled`）は成立しない。
    expect(events.some((e) => e.eventType === "ChargeCancelled")).toBe(false);
    const stunAppliedIndex = events.findIndex(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === enemy.battleUnitId,
    );
    const releaseCompletedIndex = events.findIndex((e) => e.eventType === "ChargeReleaseCompleted");
    expect(releaseCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(stunAppliedIndex).toBeGreaterThan(releaseCompletedIndex);

    // charge削除の所有者は終了イベントの1件だけ。二重の削除差分を持たない。
    expect(
      events
        .filter((event) => event.stateDelta?.units?.[charger.battleUnitId]?.charge !== undefined)
        .map((event) => event.eventType),
    ).toEqual(["ChargeReleaseCompleted"]);

    // 公開差分を全件当て直しても`before`不一致で落ちず、チャージは消えている。
    const restored = reduceStateDeltas(
      initialSnapshot,
      events.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(restored.units[charger.battleUnitId]?.charge).toBeUndefined();
    expect(
      result.units.find((u) => u.battleUnitId === charger.battleUnitId)!.charge,
    ).toBeUndefined();
  });
});
