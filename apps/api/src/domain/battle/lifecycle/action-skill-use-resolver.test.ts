import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
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
    currentHp?: number;
    maximumHp?: number;
    currentAp?: number;
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
  };
}

function unitDefinitionOf(id: UnitDefinitionId): UnitDefinition {
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
    passiveSkillDefinitionIds: [],
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
          condition: { kind: "TRUE" },
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

/**
 * R-SKL-07（RES-003、Issue #173、PR #216レビュー[P1]）: `steps`の唯一のstepが
 * `BRANCH`（`condition: TRUE`のthenSteps側）で実際の`DAMAGE` ACTIONを内包する
 * AS skill。`resolveSkillOrder`はこのstepを`DeferredStepPlan`として返すため、
 * `targetUnitIds`（`SkillUseStarting`/`TargetsSelected`/`SkillUseCompleted`が
 * 公開する）が、BRANCHの内側からも実際の対象を正しく収集できているかを
 * 実ライフサイクルで検証する。
 */
function asSkillWithBranch(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_AS_BRANCH"),
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
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              condition: { kind: "TRUE" },
              target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
              actions: [
                { effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) },
              ],
            },
          ],
          elseSteps: [],
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
    metadata: { displayName: "AS Branch", tags: [] },
  };
}

/**
 * R-SKL-07（RES-003、Issue #173、PR #216再々々々レビュー[P1]）: `steps`の唯一の
 * stepが`REPEAT`（`count`回、自傷DAMAGEを繰り返す）のAS skill。1回目の自傷で
 * actorが戦闘不能になった場合、残り`count - 1`回のiterationが未解決のまま
 * 残ることを実ライフサイクル（`SkillUseInterrupted`/`unresolvedEffectCount`）で
 * 検証するために使う。
 */
function asSkillWithRepeatSelfHit(effectActionId: string, count: number): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_AS_REPEAT_SELF"),
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
          kind: "REPEAT",
          count,
          steps: [
            {
              kind: "ACTION",
              condition: { kind: "TRUE" },
              target: { kind: "SELF" },
              actions: [
                { effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) },
              ],
            },
          ],
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
    metadata: { displayName: "AS Repeat Self", tags: [] },
  };
}

/**
 * R-SKL-01（RES-003、PR #216再々々々々々レビュー[P1]）: 最初のstepの自傷DAMAGEで
 * actorが戦闘不能になり、2番目のstep（BRANCH、thenSteps内はfalse condition
 * のACTIONのみ）がまったく未着手のまま残るAS skill。BRANCHのthenSteps自体は
 * 実行されればfalse conditionでR-SKL-06によりスキップされる＝寄与0のため、
 * 「戦闘不能を観測しただけ」で`SkillUseInterrupted`を誤発行しないことを
 * 検証するために使う。
 */
function asSkillWithSelfHitThenAbandonedFalseBranch(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_AS_SELF_THEN_FALSE_BRANCH"),
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
          condition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
        {
          kind: "BRANCH",
          condition: { kind: "TRUE" },
          thenSteps: [
            {
              kind: "ACTION",
              condition: { kind: "NOT", condition: { kind: "TRUE" } },
              target: { kind: "SELF" },
              actions: [
                { effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) },
              ],
            },
          ],
          elseSteps: [],
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
    metadata: { displayName: "AS Self Then Abandoned False Branch", tags: [] },
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

  it("UT-R-SKL-07-008 (R-SKL-07, PR #216レビュー[P1]): a BRANCH-only AS skill's SkillUseStarting/TargetsSelected/SkillUseCompleted still publish the enemy actually hit inside the BRANCH's thenSteps, through the real resolveSkillOrder -> resolveSkillUse lifecycle", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR");
    const enemyUnitDefinitionId = createUnitDefinitionId("UNIT_ENEMY");
    const hit = damageEffectAction("ACT_BRANCH_HIT");
    const skill = asSkillWithBranch("ACT_BRANCH_HIT");

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

    resolveSkillUse(
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
    // The real EffectAction application inside the BRANCH's thenSteps did
    // happen (proves this isn't a false positive from an empty branch).
    expect(events.some((e) => e.eventType === "DamageApplied")).toBe(true);

    // `TargetsSelected` carries the plan's targetUnitIds on the event
    // envelope itself (its payload only carries per-binding `selectedTargetUnitIds`,
    // which was never affected by this bug since targetBindings are resolved
    // independently of BRANCH/RANDOM_BRANCH/REPEAT structure).
    const targetsSelected = events.find((e) => e.eventType === "TargetsSelected");
    expect(targetsSelected, 'expected a "TargetsSelected" event').toBeDefined();
    expect(targetsSelected!.targetUnitIds).toEqual([enemy.battleUnitId]);

    for (const eventType of ["SkillUseStarting", "SkillUseCompleted"] as const) {
      const event = events.find((e) => e.eventType === eventType);
      expect(event, `expected a "${eventType}" event`).toBeDefined();
      expect(
        (event!.payload as { targetUnitIds?: readonly string[] }).targetUnitIds,
        `"${eventType}".payload.targetUnitIds`,
      ).toEqual([enemy.battleUnitId]);
    }
  });

  it("UT-R-SKL-07-015 (R-SKL-01, PR #216再々々々レビュー[P1]): a REPEAT that kills the actor on its first iteration correctly emits SkillUseInterrupted (not SkillUseCompleted) with unresolvedEffectCount counting the remaining un-started iterations, through the real resolveSkillOrder -> resolveSkillUse lifecycle", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR");
    const hit = damageEffectAction("ACT_REPEAT_SELF_HIT");
    // 3 iterations; a self-hit's damage is clamped to the minimum of 1 (10
    // attack - 10 own defense), so currentHp: 1 makes the first hit lethal,
    // leaving 2 iterations unresolved.
    const skill = asSkillWithRepeatSelfHit("ACT_REPEAT_SELF_HIT", 3);

    const actor = unit("ACTOR", "ALLY", {
      unitDefinitionId: actorUnitDefinitionId,
      currentAp: 3,
      currentHp: 1,
    });

    const definitions = definitionsOf(
      new Map([[actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId)]]),
      new Map(),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    resolveSkillUse(
      actor,
      skill,
      "AS",
      "AS",
      [actor],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    expect(events.filter((e) => e.eventType === "DamageApplied")).toHaveLength(1);
    expect(events.some((e) => e.eventType === "SkillUseCompleted")).toBe(false);
    const interrupted = events.find((e) => e.eventType === "SkillUseInterrupted");
    expect(interrupted, 'expected a "SkillUseInterrupted" event').toBeDefined();
    expect(interrupted!.payload).toMatchObject({
      reason: "ACTOR_DEFEATED",
      resolvedEffectCount: 1,
      unresolvedEffectCount: 2,
    });
  });

  it("UT-R-SKL-07-022 (R-SKL-01, PR #216再々々々々々レビュー[P1]): a self-hit that kills the actor, followed by an abandoned BRANCH whose only content is a false-condition ACTION, still emits SkillUseCompleted (not SkillUseInterrupted) since nothing was actually discarded, through the real resolveSkillOrder -> resolveSkillUse lifecycle", () => {
    const actorUnitDefinitionId = createUnitDefinitionId("UNIT_ACTOR");
    const hit = damageEffectAction("ACT_SELF_THEN_FALSE_BRANCH");
    const skill = asSkillWithSelfHitThenAbandonedFalseBranch("ACT_SELF_THEN_FALSE_BRANCH");

    // A self-hit's damage is clamped to the minimum of 1 (10 attack - 10 own
    // defense), so currentHp: 1 makes the single hit lethal.
    const actor = unit("ACTOR", "ALLY", {
      unitDefinitionId: actorUnitDefinitionId,
      currentAp: 3,
      currentHp: 1,
    });

    const definitions = definitionsOf(
      new Map([[actorUnitDefinitionId, unitDefinitionOf(actorUnitDefinitionId)]]),
      new Map(),
      new Map([[hit.effectActionDefinitionId, hit]]),
    );
    const recorder = new EventRecorder(createBattleId("B_1"));

    resolveSkillUse(
      actor,
      skill,
      "AS",
      "AS",
      [actor],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const events = recorder.getEvents();
    expect(events.filter((e) => e.eventType === "DamageApplied")).toHaveLength(1);
    expect(events.some((e) => e.eventType === "SkillUseInterrupted")).toBe(false);
    const completed = events.find((e) => e.eventType === "SkillUseCompleted");
    expect(completed, 'expected a "SkillUseCompleted" event').toBeDefined();
  });
});
