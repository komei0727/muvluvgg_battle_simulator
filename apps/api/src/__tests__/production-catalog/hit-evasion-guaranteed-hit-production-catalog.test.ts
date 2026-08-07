import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * M7-018（Issue #272、R-HIT-04「Nヒット回避」/R-HIT-05「必中付与」、
 * `CAP_HIT_COUNT_EVASION`/`CAP_STATUS_EFFECT_KIND`）: production Catalogの
 * `ACT_FLUTE_VAMPIRE_PS2_EVASION`（`APPLY_STATUS`/`status: HIT_EVASION`、
 * `timeLimit: ACTION(1)` + `consumption: INCOMING_HIT(1)`）と
 * `ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT`（`status: GUARANTEED_HIT`、
 * `timeLimit: SKILL_USE(4)`）を実カタログから読み込み、実ライフサイクル
 * （`resolveSkillUse`→`resolveEffectSequencePlan`→`grantEffect`のAPPLY_STATUS
 * resolver→`damage-application-service.ts`の命中判定）経由で近似なしに
 * 解決できることを検証する。
 *
 * 定義元スキル（`SKL_FLUTE_VAMPIRE_PS2`/`SKL_LAYLA_ENTREPRENEUR_PS1`）自身は
 * 同じ解決の中で別Taskが担当する未実装kind（`APPLY_DAMAGE_MOD`＝`CAP_DAMAGE_MOD`
 * /DMG-002等）も解決するため、`mao-committee-ps2-stealth-production-catalog.test.ts`
 * と同じ方針で、実カタログのEffectActionDefinitionそのものだけを単一actionに持つ
 * 最小限の合成AS skillで包んで検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const FLUTE_UNIT_ID = "UNIT_FLUTE_VAMPIRE";
const LAYLA_UNIT_ID = "UNIT_LAYLA_ENTREPRENEUR";
const HIT_EVASION_EFFECT_ID = "ACT_FLUTE_VAMPIRE_PS2_EVASION";
const GUARANTEED_HIT_EFFECT_ID = "ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT";
const ATTACKER_UNIT_ID = "UNIT_TEST_HIT_ATTACKER";
const ATTACK_EFFECT_ID = "ACT_TEST_HIT_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const COMBAT_STATS = { maximumHp: 100, attack: 50, defense: 0 };

/** 実production EffectActionDefinitionだけを自己対象で解決する最小限の合成AS。 */
function selfGrantSkill(skillId: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
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
    metadata: { displayName: skillId, tags: [] },
  };
}

function attackerSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST_HIT_ATTACKER"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
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
    metadata: { displayName: "TestHitAttacker", tags: [] },
  };
}

/** 2ヒットの通常命中（`accuracy.mode: NORMAL`）攻撃。 */
function twoHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 2,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
}

function fixture(unitIds: readonly string[], skills: readonly SkillDefinition[]): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);
  const attack = twoHitAttack();
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(attack.effectActionDefinitionId, attack);
  return {
    definitions: definitionsWith(snapshot, {
      units: [testUnitDefinition(ATTACKER_UNIT_ID, { baseStats: COMBAT_STATS })],
      skills,
      overrides: { effectActions },
    }),
    recorder: new EventRecorder(createBattleId("B_1")),
  };
}

describe("production Catalog HIT_EVASION / GUARANTEED_HIT (M7-018, Issue #272, R-HIT-04/R-HIT-05)", () => {
  it("IT-CAP-HIT-EVASION-PROD-001 (R-ACTN-03/R-HIT-04, real lifecycle wiring): resolving the real ACT_FLUTE_VAMPIRE_PS2_EVASION definition through resolveSkillUse grants a statusKind:HIT_EVASION AppliedEffect with the production-defined ACTION(1) time limit and INCOMING_HIT(1) consumption, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_HIT_EVASION", HIT_EVASION_EFFECT_ID);
    const { definitions, recorder } = fixture([FLUTE_UNIT_ID], [grantSkill]);
    const flute = testBattleUnit({
      battleUnitId: "ally:flute",
      unitDefinitionId: FLUTE_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });

    const result = resolveSkillUse(
      flute,
      grantSkill,
      "AS",
      "AS",
      [flute],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const fluteAfter = result.units.find((u) => u.battleUnitId === flute.battleUnitId)!;
    expect(fluteAfter.appliedEffects).toHaveLength(1);
    const evasion = fluteAfter.appliedEffects[0]!;
    expect(evasion).toMatchObject({
      effectActionDefinitionId: HIT_EVASION_EFFECT_ID,
      statusKind: "HIT_EVASION",
      statusDetails: { probability: 1 },
      duplicate: true,
      magnitude: 0,
    });
    expect(evasion.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 1 },
      consumption: { kind: "INCOMING_HIT", maxCount: 1 },
    });
    expect(evasion.duration.timeLimitRemaining).toBe(1);
    expect(evasion.duration.consumptionRemaining).toBe(1);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      statusKind: "HIT_EVASION",
      durationUnit: "ACTION",
      initialRemaining: 1,
    });

    const emptyState = initialSnapshotFor([flute], { status: "READY" });
    const reduced = applyStateDelta(emptyState, applied.stateDelta!);
    expect(reduced.units[flute.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[flute.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: HIT_EVASION_EFFECT_ID,
      statusKind: "HIT_EVASION",
      duration: { unit: "ACTION", remaining: 1 },
      consumptionRemaining: 1,
    });
  });

  it("IT-CAP-HIT-EVASION-PROD-002 (R-HIT-04, CAP_HIT_COUNT_EVASION): the real production HIT_EVASION instance evades exactly the first incoming hit, expires by CONSUMPTION on that evaded hit, and lets the second hit of the same attack land", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_HIT_EVASION", HIT_EVASION_EFFECT_ID);
    const attackSkill = attackerSkill();
    const { definitions, recorder } = fixture([FLUTE_UNIT_ID], [grantSkill, attackSkill]);
    const flute = testBattleUnit({
      battleUnitId: "ally:flute",
      unitDefinitionId: FLUTE_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });
    const attacker = testBattleUnit({
      battleUnitId: "enemy:attacker",
      unitDefinitionId: ATTACKER_UNIT_ID,
      side: "ENEMY",
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });

    const granted = resolveSkillUse(
      flute,
      grantSkill,
      "AS",
      "AS",
      [flute, attacker],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const evasionInstance = granted.units.find((u) => u.battleUnitId === flute.battleUnitId)!
      .appliedEffects[0]!;
    const eventsBeforeAttack = recorder.getEvents().length;

    const attacked = resolveSkillUse(
      granted.units.find((u) => u.battleUnitId === attacker.battleUnitId)!,
      attackSkill,
      "AS",
      "AS",
      granted.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );

    const fluteAfter = attacked.units.find((u) => u.battleUnitId === flute.battleUnitId)!;
    // 1ヒット目は回避、2ヒット目は命中する（Nヒット回避のNは1）。
    expect(fluteAfter.currentHp).toBeLessThan(flute.currentHp);
    expect(fluteAfter.appliedEffects).toHaveLength(0);

    const attackEvents = recorder.getEvents().slice(eventsBeforeAttack);
    const evasionActivated = attackEvents.filter((e) => e.eventType === "EvasionActivated");
    expect(evasionActivated).toHaveLength(1);
    expect(evasionActivated[0]!.payload).toMatchObject({
      effectInstanceId: evasionInstance.effectInstanceId,
      hitIndex: 1,
    });
    expect(attackEvents.filter((e) => e.eventType === "HitConfirmed")).toHaveLength(1);

    const consumption = attackEvents.find(
      (e) => e.eventType === "EffectConsumptionChanged",
    ) as Extract<BattleDomainEvent, { eventType: "EffectConsumptionChanged" }>;
    expect(consumption).toBeDefined();
    expect(consumption.payload).toMatchObject({
      effectInstanceId: evasionInstance.effectInstanceId,
      kind: "INCOMING_HIT",
      before: 1,
      after: 0,
    });
    const expired = attackEvents.find((e) => e.eventType === "EffectExpired") as Extract<
      BattleDomainEvent,
      { eventType: "EffectExpired" }
    >;
    expect(expired).toBeDefined();
    expect(expired.payload).toMatchObject({
      effectInstanceId: evasionInstance.effectInstanceId,
      reason: "CONSUMPTION",
    });
  });

  it("IT-CAP-GUARANTEED-HIT-PROD-001 (R-ACTN-03/R-HIT-05, real lifecycle wiring): resolving the real ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT definition through resolveSkillUse grants a statusKind:GUARANTEED_HIT AppliedEffect with the production-defined SKILL_USE(4) duration, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const grantSkill = selfGrantSkill("SKL_TEST_GRANT_GUARANTEED_HIT", GUARANTEED_HIT_EFFECT_ID);
    const { definitions, recorder } = fixture([LAYLA_UNIT_ID], [grantSkill]);
    const layla = testBattleUnit({
      battleUnitId: "ally:layla",
      unitDefinitionId: LAYLA_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });

    const result = resolveSkillUse(
      layla,
      grantSkill,
      "AS",
      "AS",
      [layla],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const laylaAfter = result.units.find((u) => u.battleUnitId === layla.battleUnitId)!;
    expect(laylaAfter.appliedEffects).toHaveLength(1);
    const guaranteed = laylaAfter.appliedEffects[0]!;
    expect(guaranteed).toMatchObject({
      effectActionDefinitionId: GUARANTEED_HIT_EFFECT_ID,
      statusKind: "GUARANTEED_HIT",
      duplicate: true,
      magnitude: 0,
    });
    expect(guaranteed.duration.definition).toMatchObject({
      timeLimit: { unit: "SKILL_USE", count: 4 },
    });
    expect(guaranteed.duration.timeLimitRemaining).toBe(4);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      statusKind: "GUARANTEED_HIT",
      durationUnit: "SKILL_USE",
      initialRemaining: 4,
    });

    const emptyState = initialSnapshotFor([layla], { status: "READY" });
    const reduced = applyStateDelta(emptyState, applied.stateDelta!);
    expect(reduced.units[layla.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[layla.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: GUARANTEED_HIT_EFFECT_ID,
      statusKind: "GUARANTEED_HIT",
      duration: { unit: "SKILL_USE", remaining: 4 },
    });
  });

  it("IT-CAP-GUARANTEED-HIT-PROD-002 (R-HIT-05 #2, CAP_STATUS_EFFECT_KIND): an attacker holding the real production GUARANTEED_HIT buff lands both hits of a NORMAL-accuracy attack through the real production HIT_EVASION buff, and no EvasionActivated is recorded", () => {
    const grantGuaranteed = selfGrantSkill(
      "SKL_TEST_GRANT_GUARANTEED_HIT",
      GUARANTEED_HIT_EFFECT_ID,
    );
    const grantEvasion = selfGrantSkill("SKL_TEST_GRANT_HIT_EVASION", HIT_EVASION_EFFECT_ID);
    const attackSkill = attackerSkill();
    const { definitions, recorder } = fixture(
      [LAYLA_UNIT_ID, FLUTE_UNIT_ID],
      [grantGuaranteed, grantEvasion, attackSkill],
    );
    const layla = testBattleUnit({
      battleUnitId: "ally:layla",
      unitDefinitionId: LAYLA_UNIT_ID,
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });
    const flute = testBattleUnit({
      battleUnitId: "enemy:flute",
      unitDefinitionId: FLUTE_UNIT_ID,
      side: "ENEMY",
      position: { column: "CENTER", row: "FRONT" },
      combatStats: COMBAT_STATS,
      limits: LIMITS,
      overrides: { currentAp: LIMITS.maximumAp },
    });

    const afterGuaranteed = resolveSkillUse(
      layla,
      grantGuaranteed,
      "AS",
      "AS",
      [layla, flute],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:1"),
      recorder.nextResolutionScopeId(),
    );
    const afterEvasion = resolveSkillUse(
      afterGuaranteed.units.find((u) => u.battleUnitId === flute.battleUnitId)!,
      grantEvasion,
      "AS",
      "AS",
      afterGuaranteed.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:2"),
      recorder.nextResolutionScopeId(),
    );
    const eventsBeforeAttack = recorder.getEvents().length;

    const attacked = resolveSkillUse(
      afterEvasion.units.find((u) => u.battleUnitId === layla.battleUnitId)!,
      attackSkill,
      "AS",
      "AS",
      afterEvasion.units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_1:action:3"),
      recorder.nextResolutionScopeId(),
    );

    const attackEvents = recorder.getEvents().slice(eventsBeforeAttack);
    expect(attackEvents.filter((e) => e.eventType === "EvasionActivated")).toHaveLength(0);
    expect(attackEvents.filter((e) => e.eventType === "HitConfirmed")).toHaveLength(2);

    const fluteAfter = attacked.units.find((u) => u.battleUnitId === flute.battleUnitId)!;
    expect(fluteAfter.currentHp).toBeLessThan(flute.currentHp);
  });
});
